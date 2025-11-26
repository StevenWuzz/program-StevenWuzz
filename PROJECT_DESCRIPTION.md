# Project Description

**Deployed Frontend URL:** https://solana-lending-program.vercel.app/

**Solana Program ID:** 8L5TT5QKsktaowcfstwz2h6aNg5Q9izfuLLq76wyJqZ

## Project Overview

### Description
Lending Solana is a lending dApp deployed on Solana Devnet based on each user's deposited collateral. There is only **one** lending market derived from fixed seeds; the first wallet to initialize it becomes the authority that can later fund the loan vault. Decentralized governance is not yet implemented, although ideally it should be done via a multisig or a DAO.

The lending market owns the collateral/loan token mints and token vaults with a stored 5% interest parameter and 120% collateral loan rate (interest accrual/repay flows are not yet implemented on-chain). Connected wallets create their own user account PDA, deposit collateral into the market-owned collateral vault, and can borrow synthetic loan tokens as long as the collateral ratio and vault liquidity are respected. The frontend exposes every instruction behind a wallet-gated control panel and refreshes market and user state after each operation.

Due to time constraints, this project does not have a feature to repay loans, liquidate users based on their collaterals, etc. However, a proper and ideal decentralized lending app should have those capabilities.

Because the market PDA can only be created once, the `Initialize Lending Market` button becomes disabled after the first successful initialization and the UI shows the stored authority. The button to fund the loan vault is only visible to that authority wallet. 

![Only an authorized wallet can execute these operations](frontend.png)


### Key Features
- **One-click market bootstrap** – The first initializer derives and creates the lending market along with its collateral/loan mints and vaults directly from the UI; after that, the button is disabled and the stored authority is used for admin flows.
- **Per-wallet user accounts** – Each wallet owns a PDA user account that records a particular user's deposited collateral and borrowed tokens
- **Collateralized borrowing flow** – A user can deposit collateral tokens to the wallet, transfer them into the vault, and then request to borrow some tokens within the 120% collateral ratio.
- **Admin liquidity tooling** – The market authority has a dedicated panel to mint fresh liquidity into the loan vault so users always have tokens to borrow.
- **Clear and concise UX** – The frontend auto-creates associated token accounts, formats token amounts, refreshes vault liquidity after each instruction, and streams status messages.
  
### How to Use the dApp
1. **Connect Wallet** – Open the deployed site on Devnet and connect using the wallet adapter button.
2. **Initialize lending market (once per deployment)** – If no market exists, the connected wallet can execute `Initialize Lending Market`, which derives every PDA (market, mints, vaults) and stores the caller as authority. Once it exists, the UI reuses the deployed market instead of re-initializing.
3. **Create user account** – Click “Create user account” to initialize your PDA (seeded by your wallet) that will track deposits and borrows.
4. **Fund the loan vault (authority only)** – The market authority can mint liquidity into the loan vault via the `Fund Loan Vault` form, so borrowers should always have tokens to draw from.
5. **Deposit collateral** – Enter an amount, let the UI create your associated token account if needed, and click on `Deposit Collateral`. The program mints collateral tokens on-chain and moves them into the market vault while updating your total deposited collateral.
6. **Borrow tokens** – Choose an amount up to the displayed maximum amount (under the `Your remaining borrow capacity` text) and click on `Borrow Tokens`. The program enforces the 120% collateral ratio and sufficient vault liquidity before transferring the loan tokens to your Associated Token Account. 
7. **Monitor status** – The dashboard shows PDA addresses, token account balances, vault liquidity, and textual status updates for every instruction you send.

## Program Architecture
The Anchor program (`anchor_project/programs/lending-solana`) revolves around a `LendingMarket` PDA that owns both SPL token mints and vaults. Initialization seeds this PDA and configures interest and collateral ratios. Each wallet creates a deterministic `UserAccount` PDA that records deposited collateral and borrowed amounts. Deposits mint the market’s collateral token to the user before moving it into the PDA-owned vault, ensuring accounting is updated atomically. Borrowing calculates the maximum allowable loan based on the stored collateral ratio (in basis points), enforces liquidity in the loan vault, and performs a PDA-signed transfer into the borrower’s ATA. The market authority can inject liquidity by minting new loan tokens straight into the vault.

### PDA Usage
Every PDA is derived deterministically so both the tests and frontend can calculate addresses without user input.

**PDAs Used:**
- **`LendingMarket` (`["lending-market-v2"]`)** – Holds global configuration, owns both token mints and both vaults, and acts as the signer when minting or transferring protocol tokens.
- **`CollateralMint` (`["collateral-mint-v2", lending_market]`)** – SPL mint that represents the synthetic collateral token accepted by the market.
- **`CollateralVault` (`["collateral-vault-v2", lending_market]`)** – Token account owned by the market PDA; stores all deposited collateral.
- **`LoanMint` (`["loan-mint-v2", lending_market]`)** – SPL mint that represents the synthetic asset users borrow against their collateral.
- **`LoanVault` (`["loan-vault-v2", lending_market]`)** – Token account owned by the market PDA that holds available loan liquidity.
- **`UserAccount` (`["user-account-v2", user_pubkey]`)** – Stores per-wallet collateral and borrowing totals and is referenced from every user instruction through `has_one` checks.

### Program Instructions
**Instructions Implemented:**
- **`initialize_lending_market`** – Creates the market PDA plus collateral/loan mints and vault token accounts, stores authority, interest rate, collateral ratio, and initializes accounting fields.
- **`create_user_account`** – Initializes a user-scoped PDA seeded by the wallet address and ties it to the lending market so that later instructions can validate ownership.
- **`deposit_collateral`** – Checks overflow, mints collateral tokens under PDA authority, transfers them from the user into the collateral vault, and updates both user and global collateral totals.
- **`borrow_token`** – Calculates the maximum borrowable amount from collateral ratio rules, verifies vault liquidity, then PDA-signs a transfer from the loan vault into the user’s loan ATA while updating accounting.
- **`fund_loan_vault`** – Allows only the stored market authority to mint additional loan tokens directly into the loan vault, increasing available liquidity for future borrows.

### Account Structure
```rust
#[account]
pub struct LendingMarket {
    pub authority: Pubkey,
    pub collateral_mint: Pubkey,
    pub loan_mint: Pubkey,
    pub collateral_vault: Pubkey,
    pub loan_vault: Pubkey,
    pub interest_rate_bps: u16,
    pub collateral_ratio_bps: u16,
    pub collateral_amount: u64,
    pub borrowed_amount: u64,
    pub bump: u8,
}

#[account]
pub struct UserAccount {
    pub user: Pubkey,
    pub lending_market: Pubkey,
    pub deposited_collateral_amount: u64,
    pub borrowed_amount: u64,
    pub bump: u8,
}
```
`LendingMarket` is the canonical state account that anchors every PDA and stores risk parameters plus aggregate balances. `UserAccount` encodes each wallet’s position and is referenced by `has_one` constraints so malicious users cannot act on someone else’s accounts.

## Testing

### Test Coverage
All instructions are covered in `anchor_project/tests/lending-solana.ts` using Anchor’s Mocha setup. The suite derives the same PDAs as the program/frontend, performs real CPI calls, inspects SPL token accounts, and asserts both success paths and failure cases.

**Happy Path Tests:**
- `initialize_lending_market` populates every field, verifies mint/vault ownership, and checks that both vaults start at zero tokens.
- `create_user_account` ensures a wallet can only initialize its own PDA and that the resulting account stores zeroed balances tied to the right market.
- `deposit_collateral` mints collateral, transfers it into the vault, and confirms user + market collateral accounting increased as expected.
- `borrow_token` validates a user can borrow within the 120% ratio, receives the tokens, and that the vault balance decreases accordingly.
- `fund_loan_vault` confirms the market authority can mint liquidity into the vault and that its balance increases.

**Unhappy Path Tests:**
- Re-initializing the lending market fails because the PDA already exists.
- A malicious wallet cannot create a user account for someone else due to seed and constraint checks.
- Depositing collateral from another user’s token account is rejected because ownership constraints fail.
- Borrowing fails when the loan vault lacks liquidity, so users cannot pull nonexistent funds.
- Borrow requests that exceed the maximum allowable amount revert with the `UserMaxBorrowExceeded` error.
- Borrowing with mixed-up user accounts or loan token accounts fails because `has_one` and signer constraints catch the mismatch.
- Non-authorities attempting to fund the vault hit the authority constraint and revert.

### Running Tests
```bash
anchor test
```

### Additional Notes for Evaluators
- The frontend (Next.js App Router) consumes the generated Anchor IDL from `frontend/anchor-idl`, derives all PDAs locally, and uses the wallet adapter to sign instructions on Devnet.
- Token amounts use six decimals everywhere, and the UI includes helpers to parse/format them plus auto-creation of missing associated token accounts before deposits or borrows.
- The on-chain program currently only tracks principal: it stores `interest_rate_bps` for future use but does not yet accrue interest or include repayment/liquidation logic.
- The market can be re-used across sessions: initialization is idempotent, and every connected wallet sees live on-chain state (market stats, vault liquidity, borrow limits) without needing to redeploy.
