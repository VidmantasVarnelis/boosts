import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { format } from 'date-fns';
import {
  ApplicationPlatform,
  PromotionType,
  SubscriptionPlan,
} from '@repo/database';
import { getAccountBalance, TransactionService } from '@solana-bot/core';
import {
  PrismaSubscriptionRepository,
  PrismaUserRepository,
} from '@repo/database/repositories';
import {
  BETTER_CALL_SOL_PK,
  Config,
  HOBBY_PLAN_FEE,
  MAX_HOBBY_PERIOD,
  MAX_PRO_PERIOD,
  PaymentsMessageEnum,
  PRO_PLAN_FEE,
  SUBSCRIPTION_HIERARCHY,
} from '../../constants';
import { BoostsSubscriptionPlan } from 'src/typings';

export class PaymentsService {
  private readonly transactionService: TransactionService;
  private readonly SIGNATURE_FEE = 5000;

  constructor(
    private readonly config: Config,
    private readonly prismaUserRepository: PrismaUserRepository,
    private readonly prismaSubscriptionRepository: PrismaSubscriptionRepository
  ) {
    this.transactionService = new TransactionService(this.config.connection);
  }

  public async chargeSubscription(
    userId: string,
    plan: BoostsSubscriptionPlan,
    platform: ApplicationPlatform
  ): Promise<{
    success: boolean;
    message: PaymentsMessageEnum;
    subscriptionEnd: string | null;
  }> {
    const user = await this.prismaUserRepository.getById(userId);

    if (!user) {
      return {
        success: false,
        message: PaymentsMessageEnum.NO_USER_FOUND,
        subscriptionEnd: null,
      };
    }

    const subscription = user.userSubscriptions.find(
      (sub) => sub.platform === platform
    );

    if (this.isInvalidUpgrade(plan, subscription?.plan)) {
      return {
        success: false,
        message: PaymentsMessageEnum.USER_ALREADY_PAID,
        subscriptionEnd: null,
      };
    }

    const userPublicKey = new PublicKey(user.personalWalletPubKey);
    const balance = await getAccountBalance(
      this.config.connection,
      userPublicKey
    );

    if (!balance) {
      return {
        success: false,
        message: PaymentsMessageEnum.INSUFFICIENT_BALANCE,
        subscriptionEnd: null,
      };
    }

    const planFee = this.getPlanFee(plan);

    if (!planFee) {
      return {
        success: false,
        message: PaymentsMessageEnum.INVALID_PLAN,
        subscriptionEnd: null,
      };
    }

    if (balance >= planFee) {
      try {
        const transaction = this.createTransaction(
          userPublicKey,
          planFee - this.SIGNATURE_FEE
        );
        const userKeypair = this.getKeypairFromPrivateKey(
          user.personalWalletPrivKey
        );

        const { confirmed } =
          await this.transactionService.createAndSendNativeV0Tx(
            transaction.instructions,
            userKeypair
          );

        if (!confirmed) {
          return {
            success: false,
            message: PaymentsMessageEnum.INTERNAL_ERROR,
            subscriptionEnd: null,
          };
        }

        return this.updateUserSubscription(user.id, plan, platform);
      } catch (error) {
        return {
          success: false,
          message: PaymentsMessageEnum.INTERNAL_ERROR,
          subscriptionEnd: null,
        };
      }
    }

    // create a free subscription of they dont have balance and subscription
    if (!subscription?.plan) {
      await this.prismaSubscriptionRepository.updateUserSubscription(
        user.id,
        'FREE',
        platform
      );
    }

    return {
      success: false,
      message: PaymentsMessageEnum.INSUFFICIENT_BALANCE,
      subscriptionEnd: null,
    };
  }

  public async chargeDonation(
    userId: string,
    donation: number
  ): Promise<{ success: boolean; message: PaymentsMessageEnum }> {
    const user = await this.prismaUserRepository.getById(userId);

    if (!user) {
      return { success: false, message: PaymentsMessageEnum.NO_USER_FOUND };
    }

    const userPublicKey = new PublicKey(user.personalWalletPubKey);
    const balance = await getAccountBalance(
      this.config.connection,
      userPublicKey
    );

    if (!balance) {
      return {
        success: false,
        message: PaymentsMessageEnum.INSUFFICIENT_BALANCE,
      };
    }

    const donationLamports = donation * LAMPORTS_PER_SOL;

    if (balance >= donationLamports) {
      try {
        const transaction = this.createTransaction(
          userPublicKey,
          donationLamports - this.SIGNATURE_FEE
        );
        const userKeypair = this.getKeypairFromPrivateKey(
          user.personalWalletPrivKey
        );

        // Sign and send the transaction
        const { confirmed } =
          await this.transactionService.createAndSendNativeV0Tx(
            transaction.instructions,
            userKeypair
          );

        if (!confirmed) {
          return {
            success: false,
            message: PaymentsMessageEnum.INTERNAL_ERROR,
          };
        }

        await this.prismaUserRepository.hasDonated(userId);

        return { success: true, message: PaymentsMessageEnum.DONATION_MADE };
      } catch (error) {
        return { success: false, message: PaymentsMessageEnum.INTERNAL_ERROR };
      }
    }

    return {
      success: false,
      message: PaymentsMessageEnum.INSUFFICIENT_BALANCE,
    };
  }

  public async chargePromotion(
    userId: string,
    promotionAmt: number,
    promotionType: PromotionType
  ): Promise<{ success: boolean; message: PaymentsMessageEnum }> {
    const user = await this.prismaUserRepository.getById(userId);

    if (!user) {
      return { success: false, message: PaymentsMessageEnum.NO_USER_FOUND };
    }

    const userPublicKey = new PublicKey(user.personalWalletPubKey);
    const balance = await getAccountBalance(
      this.config.connection,
      userPublicKey
    );

    if (!balance) {
      return {
        success: false,
        message: PaymentsMessageEnum.INSUFFICIENT_BALANCE,
      };
    }

    const promotionAmtLamports = promotionAmt * LAMPORTS_PER_SOL;

    if (balance >= promotionAmtLamports) {
      try {
        const transaction = this.createTransaction(
          userPublicKey,
          promotionAmt - this.SIGNATURE_FEE
        );
        const userKeypair = this.getKeypairFromPrivateKey(
          user.personalWalletPrivKey
        );

        // Sign and send the transaction
        const { confirmed } =
          await this.transactionService.createAndSendNativeV0Tx(
            transaction.instructions,
            userKeypair
          );

        if (!confirmed) {
          return {
            success: false,
            message: PaymentsMessageEnum.INTERNAL_ERROR,
          };
        }

        const { message: promMessage } =
          await this.prismaSubscriptionRepository.buyPromotion(
            userId,
            promotionType
          );

        if (promMessage === 'Non-stackable promotion already purchased') {
          return {
            success: false,
            message: PaymentsMessageEnum.USER_ALREADY_PAID,
          };
        }

        return {
          success: true,
          message: PaymentsMessageEnum.TRANSACTION_SUCCESS,
        };
      } catch (error) {
        return { success: false, message: PaymentsMessageEnum.INTERNAL_ERROR };
      }
    }

    return {
      success: false,
      message: PaymentsMessageEnum.INSUFFICIENT_BALANCE,
    };
  }

  private isInvalidUpgrade(
    plan: BoostsSubscriptionPlan,
    userPlan?: SubscriptionPlan
  ): boolean {
    return (
      userPlan === plan ||
      SUBSCRIPTION_HIERARCHY[userPlan ?? 'FREE'] > SUBSCRIPTION_HIERARCHY[plan]
    );
  }

  private createTransaction(userPublicKey: PublicKey, fee: number) {
    return new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: userPublicKey,
        toPubkey: new PublicKey(BETTER_CALL_SOL_PK),
        lamports: fee,
      })
    );
  }

  private getKeypairFromPrivateKey(base64PrivateKey: string) {
    const secretKey = Buffer.from(base64PrivateKey, 'base64');
    return Keypair.fromSecretKey(secretKey);
  }

  private getPlanFee(plan: BoostsSubscriptionPlan): number | undefined {
    return { HOBBY: HOBBY_PLAN_FEE, PRO: PRO_PLAN_FEE }[plan];
  }

  private async updateUserSubscription(
    userId: string,
    plan: BoostsSubscriptionPlan,
    platform: ApplicationPlatform
  ) {
    const subscriptionPeriod = (
      { HOBBY: MAX_HOBBY_PERIOD, PRO: MAX_PRO_PERIOD } as const
    )[plan];

    const subscription =
      await this.prismaSubscriptionRepository.updateUserSubscription(
        userId,
        plan,
        platform,
        subscriptionPeriod
      );

    return {
      success: true,
      message: PaymentsMessageEnum.PLAN_UPGRADED,
      subscriptionEnd: format(
        subscription.subscriptionCurrentPeriodEnd!,
        'MM/dd/yyyy'
      ),
    };
  }
}
