import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { ConnectionLogo } from "nanocodex-connect-ui/ConnectionLogo";
import { formatDollars } from "./walletFunding";

export function TempoWalletConnectionCard({
  address, balance, fundingAmountCents, fundingAvailable, fundingError,
  fundingOperation, fundingLoading, fundingErrorSource, checkoutUrl, fundingMessage, onFund,
}: Readonly<{
  address?: string;
  balance: string;
  fundingAmountCents: number;
  fundingAvailable: boolean;
  fundingError: string | null;
  fundingErrorSource?: "order" | "configuration" | null;
  fundingOperation: "prepare" | "payment" | null;
  fundingLoading: boolean;
  checkoutUrl?: string | null;
  fundingMessage?: string | null;
  onFund(): void;
}>) {
  const [copyResult, setCopyResult] = useState<{ address: string; status: "copied" | "failed" } | null>(null);
  const copyStatus = copyResult?.address === address ? copyResult?.status : null;
  useEffect(() => setCopyResult(null), [address]);
  const busy = fundingOperation !== null;
  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopyResult({ address, status: "copied" });
    } catch {
      setCopyResult({ address, status: "failed" });
    }
  }
  const balanceReassurance = address ? " This does not affect your wallet address or existing balance." : "";
  const fundingStatus = fundingOperation === "prepare"
    ? "Preparing secure checkout…"
    : fundingOperation === "payment"
      ? "Open Stripe checkout in a new tab. Keep this page open while we check for funds."
      : fundingError
        ? fundingErrorSource === "order"
          ? fundingError
          : `Adding funds is temporarily unavailable.${balanceReassurance} Please try again later.`
        : fundingLoading
          ? "Checking funding availability…"
          : !fundingAvailable
            ? `Adding funds is currently unavailable.${balanceReassurance}`
            : fundingMessage;
  return (
    <div className="wizard-connector-card tempo-wallet-connection" id="wallet" role="listitem">
      <div className={`connection-card tempo-wallet-card${address ? " is-connected" : " is-unavailable"}`}>
        <ConnectionLogo id="tempo" />
        <div className="connection-card-copy">
          <strong>Wallet</strong>
          <span className="tempo-wallet-balance">Balance: {balance}</span>
          {fundingStatus ? <span className="tempo-wallet-message" role="status">{fundingStatus}</span> : null}
        </div>
        <span className="tempo-wallet-card-actions">
          <button disabled={!address || !fundingAvailable || fundingLoading || busy} onClick={onFund} type="button">
            {busy ? "Checking funding…" : `Add ${formatDollars(fundingAmountCents)}`}
          </button>
          {checkoutUrl ? <a href={checkoutUrl} target="_blank" rel="noopener noreferrer">Open Stripe checkout</a> : null}
        </span>
          {address ? <div className="tempo-wallet-address">
            <span>Wallet address</span>
            <code>{address}</code>
            <button aria-label="Copy wallet address" onClick={() => void copyAddress()} type="button"><Copy size={14} /> Copy address</button>
            {copyStatus === "copied" ? <span role="status">Address copied</span> : null}
            {copyStatus === "failed" ? <span role="alert">Couldn’t copy. Select the address above to copy it manually.</span> : null}
          </div> : null}
      </div>
    </div>
  );
}
