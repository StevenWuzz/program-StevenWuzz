"use client";

import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { clusterApiUrl, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ConnectionProvider,
  WalletProvider,
  useAnchorWallet,
  useConnection,
  useWallet,
} from "@solana/wallet-adapter-react";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import {
  WalletModalProvider,
  WalletMultiButton,
} from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";

import Idl from "../../anchor-idl/idl.json";
import type { LendingSolana } from "../../anchor-idl/idl";

const PROGRAM_ID = new PublicKey(Idl.address);
const MARKET_MINT_DECIMALS = 6;
const utf8 = anchor.utils.bytes.utf8;

const derivePda = (seed: string, authority?: PublicKey) => {
  const seeds = authority
    ? [utf8.encode(seed), authority.toBuffer()]
    : [utf8.encode(seed)];
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
};

const LENDING_MARKET_SEED = "lending-market-v2";
const COLLATERAL_MINT_SEED = "collateral-mint-v2";
const COLLATERAL_VAULT_SEED = "collateral-vault-v2";
const LOAN_MINT_SEED = "loan-mint-v2";
const LOAN_VAULT_SEED = "loan-vault-v2";
const USER_ACCOUNT_SEED = "user-account-v2";

const LENDING_MARKET_PDA = derivePda(LENDING_MARKET_SEED);
const COLLATERAL_MINT_PDA = derivePda(
  COLLATERAL_MINT_SEED,
  LENDING_MARKET_PDA
);
const COLLATERAL_VAULT_PDA = derivePda(
  COLLATERAL_VAULT_SEED,
  LENDING_MARKET_PDA
);
const LOAN_MINT_PDA = derivePda(LOAN_MINT_SEED, LENDING_MARKET_PDA);
const LOAN_VAULT_PDA = derivePda(LOAN_VAULT_SEED, LENDING_MARKET_PDA);

const parseTokenAmount = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || !/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Amount must be a positive number");
  }
  const [wholePart, fractionPart = ""] = trimmed.split(".");
  if (fractionPart.length > MARKET_MINT_DECIMALS) {
    throw new Error(
      `Amount supports at most ${MARKET_MINT_DECIMALS} decimal places`
    );
  }
  const base = new BN(10).pow(new BN(MARKET_MINT_DECIMALS));
  let amount = new BN(wholePart).mul(base);
  if (fractionPart.length > 0) {
    const fractional = new BN(
      fractionPart.padEnd(MARKET_MINT_DECIMALS, "0")
    );
    amount = amount.add(fractional);
  }
  if (amount.lte(new BN(0))) {
    throw new Error("Amount must be greater than zero");
  }
  return amount;
};

const formatTokenAmount = (raw: string) => {
  if (!raw || raw === "0") return "0";
  const value = new BN(raw);
  const base = new BN(10).pow(new BN(MARKET_MINT_DECIMALS));
  const whole = value.div(base).toString();
  const fraction = value
    .mod(base)
    .toString()
    .padStart(MARKET_MINT_DECIMALS, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
};

export default function Page() {
  return (
    <SolanaProvider>
      <ClientApp />
    </SolanaProvider>
  );
}

const SolanaProvider = ({ children }: { children: ReactNode }) => {
  const network = WalletAdapterNetwork.Devnet;
  const endpoint = useMemo(() => clusterApiUrl(network), [network]);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};

const ClientApp = () => {
  const { program, publicKey, connected, userAccountPda } = useProgram();
  const [status, setStatus] = useState("Ready");
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [collateralMint, setCollateralMint] = useState("");
  const [loanMint, setLoanMint] = useState("");
  const [collateralTokenAccount, setCollateralTokenAccount] = useState("");
  const [loanTokenAccount, setLoanTokenAccount] = useState("");
  const [userCollateralAmount, setUserCollateralAmount] = useState("0");
  const [loanVaultLiquidity, setLoanVaultLiquidity] = useState("0");
  const [depositAmount, setDepositAmount] = useState("");
  const [borrowAmount, setBorrowAmount] = useState("");
  const [fundAmount, setFundAmount] = useState("");
  const [marketAuthority, setMarketAuthority] = useState("");
  const [marketInitialized, setMarketInitialized] = useState(false);
  const [isMarketAuthority, setIsMarketAuthority] = useState(false);
  const [collateralRatioBps, setCollateralRatioBps] = useState(0);
  const [userBorrowedAmount, setUserBorrowedAmount] = useState("0");
  const [maxBorrowableAmount, setMaxBorrowableAmount] = useState<BN>(new BN(0));
  const formattedUserCollateral = useMemo(
    () => formatTokenAmount(userCollateralAmount),
    [userCollateralAmount]
  );
  const formattedMaxBorrowable = useMemo(() => {
    if (maxBorrowableAmount.lte(new BN(0))) return "0";
    const base = new BN(10).pow(new BN(MARKET_MINT_DECIMALS));
    const whole = maxBorrowableAmount.div(base).toString();
    const fraction = maxBorrowableAmount
      .mod(base)
      .toString()
      .padStart(MARKET_MINT_DECIMALS, "0")
      .replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole;
  }, [maxBorrowableAmount]);
  const formattedLoanVaultLiquidity = useMemo(
    () => formatTokenAmount(loanVaultLiquidity),
    [loanVaultLiquidity]
  );
  const [mounted, setMounted] = useState(false);
  const initializeDisabled =
    !connected || activeAction === "Initialize" || marketInitialized;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!publicKey || !marketAuthority) {
      setIsMarketAuthority(false);
      return;
    }
    setIsMarketAuthority(publicKey.toBase58() === marketAuthority);
  }, [marketAuthority, publicKey]);

  const applyMarketState = useCallback(
    (market: anchor.IdlAccounts<LendingSolana>["lendingMarket"]) => {
      setCollateralMint(market.collateralMint.toBase58());
      setLoanMint(market.loanMint.toBase58());
      setMarketAuthority(market.authority.toBase58());
      setMarketInitialized(true);
      setCollateralRatioBps(market.collateralRatioBps);
    },
    []
  );

  const updateLoanVaultLiquidity = useCallback(async () => {
    if (!program) return;
    const provider = program.provider;
    if (!provider) return;
    try {
      const balance = await provider.connection.getTokenAccountBalance(
        LOAN_VAULT_PDA
      );
      setLoanVaultLiquidity(balance.value.amount);
    } catch {
      setLoanVaultLiquidity("0");
    }
  }, [program]);

  const fetchAndApplyMarket = useCallback(async () => {
    if (!program) return null;
    let market: anchor.IdlAccounts<LendingSolana>["lendingMarket"] | null = null;
    try {
      market = await program.account.lendingMarket.fetchNullable(
        LENDING_MARKET_PDA
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("Failed to fetch lending market account", err);
      if (message.toLowerCase().includes("beyond buffer length")) {
        setStatus(
          "Lending market account data is invalid. Re-initialize the market to refresh it."
        );
      } else {
        setStatus(`Failed to fetch lending market: ${message}`);
      }
    }
    if (market) {
      applyMarketState(market);
    } else {
      setMarketInitialized(false);
      setMarketAuthority("");
      setCollateralMint("");
      setLoanMint("");
      setCollateralRatioBps(0);
    }
    await updateLoanVaultLiquidity();
    return market;
  }, [applyMarketState, program, setStatus, updateLoanVaultLiquidity]);

  useEffect(() => {
    fetchAndApplyMarket();
  }, [fetchAndApplyMarket]);

  const fetchAndApplyUserAccount = useCallback(async () => {
    if (!program || !userAccountPda) {
      setUserCollateralAmount("0");
      setUserBorrowedAmount("0");
      return null;
    }
    let account: anchor.IdlAccounts<LendingSolana>["userAccount"] | null = null;
    try {
      account = await program.account.userAccount.fetchNullable(
        userAccountPda
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("Failed to fetch user account", err);
      if (message.toLowerCase().includes("beyond buffer length")) {
        setStatus(
          "User account data looks corrupted. Delete and recreate it before continuing."
        );
      } else {
        setStatus(`Failed to fetch user account: ${message}`);
      }
    }
    if (account) {
      setUserCollateralAmount(account.depositedCollateralAmount.toString());
      setUserBorrowedAmount(account.borrowedAmount.toString());
    } else {
      setUserCollateralAmount("0");
      setUserBorrowedAmount("0");
    }
    return account;
  }, [program, setStatus, userAccountPda]);

  useEffect(() => {
    fetchAndApplyUserAccount();
  }, [fetchAndApplyUserAccount]);
  useEffect(() => {
    if (collateralRatioBps === 0) {
      setMaxBorrowableAmount(new BN(0));
      return;
    }
    const deposited = new BN(userCollateralAmount);
    const borrowed = new BN(userBorrowedAmount);
    if (deposited.lte(new BN(0))) {
      setMaxBorrowableAmount(new BN(0));
      return;
    }
    const maxAllowable = deposited
      .mul(new BN(10000))
      .div(new BN(collateralRatioBps));
    const remaining = maxAllowable.sub(borrowed);
    setMaxBorrowableAmount(remaining.gt(new BN(0)) ? remaining : new BN(0));
  }, [collateralRatioBps, userBorrowedAmount, userCollateralAmount]);

  const refreshUserTokenAccounts = useCallback(async () => {
    if (!program || !publicKey) {
      setCollateralTokenAccount("");
      setLoanTokenAccount("");
      return;
    }
    const provider = program.provider;
    if (!provider) return;
    const connection = provider.connection;
    const collateralMintAddress = collateralMint || COLLATERAL_MINT_PDA.toBase58();
    const loanMintAddress = loanMint || LOAN_MINT_PDA.toBase58();
    const collateralAta = getAssociatedTokenAddressSync(
      new PublicKey(collateralMintAddress),
      publicKey
    );
    const loanAta = getAssociatedTokenAddressSync(
      new PublicKey(loanMintAddress),
      publicKey
    );
    const [collateralInfo, loanInfo] = await Promise.all([
      connection.getAccountInfo(collateralAta),
      connection.getAccountInfo(loanAta),
    ]);
    setCollateralTokenAccount(collateralInfo ? collateralAta.toBase58() : "");
    setLoanTokenAccount(loanInfo ? loanAta.toBase58() : "");
  }, [collateralMint, loanMint, program, publicKey]);

  useEffect(() => {
    refreshUserTokenAccounts();
  }, [refreshUserTokenAccounts]);

  const run = useCallback(
    async (label: string, handler: () => Promise<void>) => {
      if (!program || !publicKey) {
        setStatus("Connect a wallet before running instructions");
        return;
      }
      setActiveAction(label);
      setStatus(`${label} in progress...`);
      try {
        await handler();
        setStatus(`${label} succeeded`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          message.toLowerCase().includes("user rejected") ||
          message.toLowerCase().includes("user cancel")
        ) {
          setStatus(`${label} cancelled`);
        } else {
          setStatus(`${label} failed: ${message}`);
        }
      } finally {
        setActiveAction(null);
      }
    },
    [program, publicKey]
  );

  const ensureUserTokenAccount = useCallback(
    async (mintAddress: string) => {
      if (!program || !publicKey) {
        throw new Error("Wallet not connected");
      }
      if (!mintAddress) {
        throw new Error("Initialize the market to create token mints first");
      }
      const provider = program.provider;
      if (!provider || typeof provider.sendAndConfirm !== "function") {
        throw new Error("Program provider unavailable");
      }
      const connection = provider.connection;
      const mintKey = new PublicKey(mintAddress);
      const associatedAccount = getAssociatedTokenAddressSync(mintKey, publicKey);
      const existingAccount = await connection.getAccountInfo(associatedAccount);
      if (!existingAccount) {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            publicKey,
            associatedAccount,
            publicKey,
            mintKey
          )
        );
        await provider.sendAndConfirm(tx, []);
      }
      return associatedAccount;
    },
    [program, publicKey]
  );

  const handleInitialize = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await run("Initialize", async () => {
        if (!program || !publicKey) {
          throw new Error("Wallet not connected");
        }
        if (marketInitialized) {
          setStatus("Market already initialized; reusing existing configuration");
          return;
        }
        await program!
          .methods
          .initializeLendingMarket()
          .accounts({
            lendingMarket: LENDING_MARKET_PDA,
            collateralMint: COLLATERAL_MINT_PDA,
            loanMint: LOAN_MINT_PDA,
            collateralVault: COLLATERAL_VAULT_PDA,
            loanVault: LOAN_VAULT_PDA,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        await fetchAndApplyMarket();
      });
    },
    [fetchAndApplyMarket, marketInitialized, program, publicKey, run]
  );

  const handleCreateUserAccount = useCallback(async () => {
    if (!program || !publicKey) {
      setStatus("Connect a wallet before running instructions");
      return;
    }
    if (!userAccountPda) throw new Error("Missing user PDA");
    const existingAccount = await program.account.userAccount.fetchNullable(
      userAccountPda
    );
    if (existingAccount) {
      setStatus("User account already exists");
      return;
    }
    await run("Create user account", async () => {
      await program!
        .methods
        .createUserAccount()
        .accounts({
          user: publicKey!,
          userAccount: userAccountPda,
          lendingMarket: LENDING_MARKET_PDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });
    await fetchAndApplyUserAccount();
  }, [
    fetchAndApplyUserAccount,
    program,
    publicKey,
    run,
    setStatus,
    userAccountPda,
  ]);

  const handleDeposit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await run("Deposit collateral", async () => {
        if (!userAccountPda) throw new Error("Missing user PDA");
        if (!marketInitialized) {
          throw new Error("Initialize the market before depositing collateral");
        }
        const amount = parseTokenAmount(depositAmount);
        const mintAddress = collateralMint || COLLATERAL_MINT_PDA.toBase58();
        const tokenAccount = await ensureUserTokenAccount(mintAddress);
        await program!
          .methods
          .depositCollateral(amount)
          .accounts({
            user: publicKey!,
            userAccount: userAccountPda,
            lendingMarket: LENDING_MARKET_PDA,
            collateralMint: new PublicKey(mintAddress),
            userCollateralTokenAccount: tokenAccount,
            collateralVault: COLLATERAL_VAULT_PDA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        setCollateralTokenAccount(tokenAccount.toBase58());
        setDepositAmount("");
        await fetchAndApplyUserAccount();
        await fetchAndApplyMarket();
      });
    },
    [
      fetchAndApplyUserAccount,
      collateralMint,
      depositAmount,
      ensureUserTokenAccount,
      fetchAndApplyMarket,
      marketInitialized,
      program,
      publicKey,
      run,
      userAccountPda,
    ]
  );

  const handleBorrow = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await run("Borrow tokens", async () => {
        if (!userAccountPda) throw new Error("Missing user PDA");
        if (!marketInitialized) {
          throw new Error("Initialize the market before borrowing tokens");
        }
        const mintAddress = loanMint || LOAN_MINT_PDA.toBase58();
        const loanAccountKey = await ensureUserTokenAccount(mintAddress);
        const amount = parseTokenAmount(borrowAmount);
        await program!
          .methods
          .borrowToken(amount)
          .accounts({
            user: publicKey!,
            userAccount: userAccountPda,
            lendingMarket: LENDING_MARKET_PDA,
            userLoanTokenAccount: loanAccountKey,
            loanVault: LOAN_VAULT_PDA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        setLoanTokenAccount(loanAccountKey.toBase58());
        setBorrowAmount("");
        await updateLoanVaultLiquidity();
        await fetchAndApplyUserAccount();
      });
    },
    [
      borrowAmount,
      fetchAndApplyUserAccount,
      ensureUserTokenAccount,
      loanMint,
      marketInitialized,
      updateLoanVaultLiquidity,
      program,
      publicKey,
      run,
      userAccountPda,
    ]
  );

  const handleFundLoanVault = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await run("Fund loan vault", async () => {
        if (!program || !publicKey) {
          throw new Error("Wallet not connected");
        }
        if (!isMarketAuthority) {
          throw new Error("Only the market authority can fund the loan vault");
        }
        if (!marketInitialized) {
          throw new Error("Initialize the market before funding the vault");
        }
        const amount = parseTokenAmount(fundAmount);
        const mintAddress = loanMint || LOAN_MINT_PDA.toBase58();
        await program!
          .methods
          .fundLoanVault(amount)
          .accounts({
            authority: publicKey!,
            lendingMarket: LENDING_MARKET_PDA,
            loanMint: new PublicKey(mintAddress),
            loanVault: LOAN_VAULT_PDA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        setFundAmount("");
        await updateLoanVaultLiquidity();
      });
    },
    [
      fundAmount,
      isMarketAuthority,
      loanMint,
      marketInitialized,
      program,
      publicKey,
      run,
      updateLoanVaultLiquidity,
    ]
  );
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10 text-white">
      <div className="rounded-lg border border-white/20 p-4">
        <h1 className="text-xl font-semibold">Lending Application</h1>
        <div className="mt-3 flex items-center gap-3">
          {mounted ? (
            <WalletMultiButton className="!bg-white/90 !text-slate-900" />
          ) : (
            <div className="rounded bg-white/20 px-3 py-2 text-sm text-slate-900">
              Loading wallet...
            </div>
          )}
          <span className="text-xs text-slate-300">
            {connected && publicKey ? publicKey.toBase58() : "Wallet not connected"}
          </span>
        </div>
      </div>

      <p className="rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white">
        {status}
      </p>

      <section className="space-y-4 rounded-lg border border-white/20 p-4">
        <h2 className="font-semibold">Current Market State</h2>
        <form className="space-y-2 text-sm" onSubmit={handleInitialize}>
          <p className="text-xs text-slate-300">
            Collateral and loan SPL token mints will be created automatically and
            owned by the lending market PDA. Collateral tokens represent the asset you
            lock inside the protocol, while loan tokens are a separate mint that you
            borrow against that collateral. This only needs to happen once.
          </p>
          <button
            type="submit"
            className={`rounded px-3 py-2 text-sm ${
              initializeDisabled
                ? "bg-slate-500/60 cursor-not-allowed"
                : "bg-indigo-500"
            }`}
            disabled={initializeDisabled}
          >
            {activeAction === "Initialize" ? "Sending..." : "Initialize Lending Market"}
          </button>
          {marketInitialized && (
            <p className="text-xs text-slate-400">
              Market already initialized by {marketAuthority || "unknown"}.
            </p>
          )}
        </form>
        <div className="rounded bg-black/30 px-3 py-2 text-xs">
          <p className="text-slate-300">Collateral mint</p>
          <p className="break-all font-mono text-white">
            {collateralMint || "Not created yet"}
          </p>
        </div>
        <div className="rounded bg-black/30 px-3 py-2 text-xs">
          <p className="text-slate-300">Loan mint</p>
          <p className="break-all font-mono text-white">
            {loanMint || "Not created yet"}
          </p>
        </div>
        <div className="rounded bg-black/30 px-3 py-2 text-xs">
          <p className="text-slate-300">Market authority</p>
          <p className="break-all font-mono text-white">
            {marketAuthority || "Not set"}
          </p>
        </div>
        <div className="rounded bg-black/30 px-3 py-2 text-xs">
          <p className="text-slate-300">Your deposited collateral</p>
          <p className="break-all font-mono text-white">
            {formattedUserCollateral} tokens
          </p>
        </div>
        <div className="rounded bg-black/30 px-3 py-2 text-xs">
          <p className="text-slate-300">Your remaining borrow capacity</p>
          <p className="break-all font-mono text-white">
            {formattedMaxBorrowable} loan tokens
          </p>
        </div>
        <div className="rounded bg-black/30 px-3 py-2 text-xs">
          <p className="text-slate-300">Loan vault liquidity</p>
          <p className="break-all font-mono text-white">
            {formattedLoanVaultLiquidity} tokens
          </p>
        </div>
      </section>

      {isMarketAuthority && (
        <section className="space-y-4 rounded-lg border border-white/20 p-4">
          <h2 className="font-semibold">Fund Loan Vault</h2>
          <form className="space-y-2 text-sm" onSubmit={handleFundLoanVault}>
            <p className="text-xs text-slate-300">
              Add additional loan liquidity (tokens) to the market's vault. Only the
              market authority can perform this action.
            </p>
            <input
              value={fundAmount}
              onChange={(event) => setFundAmount(event.target.value)}
              placeholder="Amount (tokens)"
              className="w-full rounded bg-black/30 px-3 py-2"
              inputMode="decimal"
              required
            />
            <button
              type="submit"
              className="rounded bg-purple-500 px-3 py-2 text-sm"
              disabled={
                !connected ||
                activeAction === "Fund loan vault" ||
                !marketInitialized
              }
            >
              {activeAction === "Fund loan vault" ? "Sending..." : "Fund"}
            </button>
          </form>
        </section>
      )}

      <section className="space-y-2 rounded-lg border border-white/20 p-4 text-sm">
        <h2 className="font-semibold">User Account</h2>
        <p>User account PDA: {userAccountPda ? userAccountPda.toBase58() : "-"}</p>
        <button
          className="rounded bg-emerald-500 px-3 py-2"
          onClick={handleCreateUserAccount}
          disabled={!connected || activeAction === "Create user account"}
        >
          {activeAction === "Create user account" ? "Sending..." : "Create user account"}
        </button>
      </section>

      <section className="space-y-4 rounded-lg border border-white/20 p-4">
        <h2 className="font-semibold">Deposit Collateral</h2>
        <form className="space-y-2 text-sm" onSubmit={handleDeposit}>
          <p className="text-xs text-slate-300">
            Collateral tokens (minted by the market's collateral mint) represent the asset you
            lock and cannot borrow directly. Your collateral associated token account will be
            created automatically if it doesn't already exist.
          </p>
          <div className="rounded bg-black/30 px-3 py-2 text-xs">
            <p className="text-slate-300">Collateral token account</p>
            <p className="break-all font-mono text-white">
              {collateralTokenAccount || "Not created yet"}
            </p>
          </div>
          <input
            value={depositAmount}
            onChange={(event) => setDepositAmount(event.target.value)}
            placeholder="Amount (tokens)"
            className="w-full rounded bg-black/30 px-3 py-2"
            inputMode="decimal"
            required
          />
          <button
            type="submit"
            className="rounded bg-blue-500 px-3 py-2"
            disabled={
              !connected ||
              activeAction === "Deposit collateral" ||
              !marketInitialized
            }
          >
            {activeAction === "Deposit collateral" ? "Sending..." : "Deposit"}
          </button>
        </form>
      </section>

      <section className="space-y-4 rounded-lg border border-white/20 p-4">
        <h2 className="font-semibold">Borrow Tokens</h2>
        <form className="space-y-2 text-sm" onSubmit={handleBorrow}>
          <p className="text-xs text-slate-300">
            Loan tokens come from a different mint than the collateral you supplied. We'll create
            the loan associated token account for you if needed, and the borrowed tokens will be
            deposited there.
          </p>
          <div className="rounded bg-black/30 px-3 py-2 text-xs">
            <p className="text-slate-300">Loan token account</p>
            <p className="break-all font-mono text-white">
              {loanTokenAccount || "Not created yet"}
            </p>
          </div>
          <input
            value={borrowAmount}
            onChange={(event) => setBorrowAmount(event.target.value)}
            placeholder="Amount (tokens)"
            className="w-full rounded bg-black/30 px-3 py-2"
            inputMode="decimal"
            required
          />
          <button
            type="submit"
            className="rounded bg-amber-500 px-3 py-2"
            disabled={
              !connected ||
              activeAction === "Borrow tokens" ||
              !marketInitialized
            }
          >
            {activeAction === "Borrow tokens" ? "Sending..." : "Borrow"}
          </button>
        </form>
      </section>

      <footer className="py-4 text-center text-xs text-slate-300">
        Provide correctly funded token accounts before running instructions.
      </footer>
    </main>
  );
};

const useProgram = () => {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { publicKey, connected } = useWallet();

  const provider = useMemo(() => {
    if (!wallet) return null;
    return new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
  }, [connection, wallet]);

  const program = useMemo(() => {
    if (!provider) return null;
    return new anchor.Program<LendingSolana>(Idl as LendingSolana, provider);
  }, [provider]);

  const userAccountPda = useMemo(() => {
    if (!publicKey) return null;
    return PublicKey.findProgramAddressSync(
      [utf8.encode(USER_ACCOUNT_SEED), publicKey.toBuffer()],
      PROGRAM_ID
    )[0];
  }, [publicKey]);

  return {
    program,
    publicKey,
    connected,
    userAccountPda,
  };
};
