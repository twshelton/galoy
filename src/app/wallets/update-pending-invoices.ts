import { InvoiceNotFoundError } from "@domain/bitcoin/lightning"
import { toLiabilitiesAccountId, DepositFeeCalculator } from "@domain/ledger"
import { LndService } from "@services/lnd"
import { LedgerService } from "@services/ledger"
import { WalletInvoicesRepository } from "@services/mongoose"
import { PriceService } from "@services/price"
import { CouldNotFindError } from "@domain/errors"
import { LockService } from "@services/lock"
import { NotificationsService } from "@services/notifications"

export const updatePendingInvoices = async ({
  walletId,
  logger,
  lock,
}: {
  walletId: WalletId
  logger: Logger
  lock?: PaymentHashLock
}) => {
  const invoicesRepo = WalletInvoicesRepository()

  const invoices = invoicesRepo.findPendingByWalletId(walletId)
  if (invoices instanceof Error) return invoices

  for await (const walletInvoice of invoices) {
    await updatePendingInvoice({ walletInvoice, logger, lock })
  }
}

export const updatePendingInvoiceByPaymentHash = async ({
  paymentHash,
  logger,
  lock,
}: {
  paymentHash: PaymentHash
  logger: Logger
  lock?: PaymentHashLock
}): Promise<boolean | ApplicationError> => {
  const invoicesRepo = WalletInvoicesRepository()
  const walletInvoice = await invoicesRepo.findByPaymentHash(paymentHash)
  if (walletInvoice instanceof CouldNotFindError) {
    logger.info({ paymentHash }, "WalletInvoice doesn't exist")
    return false
  }
  if (walletInvoice instanceof Error) return walletInvoice
  return updatePendingInvoice({ walletInvoice, logger, lock })
}

const updatePendingInvoice = async ({
  walletInvoice,
  logger,
  lock,
}: {
  walletInvoice: WalletInvoice
  logger: Logger
  lock?: PaymentHashLock
}): Promise<boolean | ApplicationError> => {
  const lndService = LndService()
  if (lndService instanceof Error) return Error

  const walletInvoicesRepo = WalletInvoicesRepository()

  const { pubkey, paymentHash, walletId } = walletInvoice
  const lnInvoiceLookup = await lndService.lookupInvoice({ pubkey, paymentHash })
  if (lnInvoiceLookup instanceof InvoiceNotFoundError) {
    const isDeleted = walletInvoicesRepo.deleteByPaymentHash(paymentHash)
    if (isDeleted instanceof Error) {
      logger.error({ walletInvoice }, "impossible to delete WalletInvoice entry")
      return isDeleted
    }
    return false
  }
  if (lnInvoiceLookup instanceof Error) return lnInvoiceLookup

  if (lnInvoiceLookup.isSettled) {
    if (walletInvoice.paid) {
      logger.info("invoice has already been processed")
      return true
    }

    const lockService = LockService()
    return lockService.lockPaymentHash({ paymentHash, logger, lock }, async () => {
      const invoiceToUpdate = await walletInvoicesRepo.findByPaymentHash(
        walletInvoice.paymentHash,
      )
      if (invoiceToUpdate instanceof CouldNotFindError) {
        logger.error(
          { paymentHash: walletInvoice.paymentHash },
          "WalletInvoice doesn't exist",
        )
        return false
      }
      if (invoiceToUpdate instanceof Error) return invoiceToUpdate
      if (invoiceToUpdate.paid) {
        logger.info("invoice has already been processed")
        return true
      }

      invoiceToUpdate.paid = true

      const updatedWalletInvoice = await walletInvoicesRepo.update(invoiceToUpdate)
      if (updatedWalletInvoice instanceof Error) return updatedWalletInvoice

      const price = await PriceService().getCurrentPrice()
      if (price instanceof Error) return price

      const { description, received } = lnInvoiceLookup
      const fee = DepositFeeCalculator(received).lnDepositFee()

      const usd = received * price
      const usdFee = fee * price

      const liabilitiesAccountId = toLiabilitiesAccountId(walletId)
      const ledgerService = LedgerService()
      const result = await ledgerService.receiveLnTx({
        liabilitiesAccountId,
        paymentHash,
        description,
        sats: received,
        fee,
        usd,
        usdFee,
      })
      if (result instanceof Error) return result

      const notificationsService = NotificationsService(logger)
      await notificationsService.lnPaymentReceived({
        amount: received,
        walletId: walletInvoice.walletId,
        paymentHash,
      })

      return true
    })
  }
}
