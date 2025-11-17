import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LendingSolana } from "../target/types/lending_solana";
import { createMint, TOKEN_PROGRAM_ID, getAccount, createAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { assert } from "chai";

describe("lending-solana", () => {
  const program = anchor.workspace.lendingSolana as Program<LendingSolana>;
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);
  const payer = provider.wallet.payer;

  const airdrop = async (connection: any, address: any, amount = 1000000000) => {
    await connection.confirmTransaction(await connection.requestAirdrop(address, amount), "confirmed");
  }
  
  const getPda = (seed: string, authority?: anchor.web3.PublicKey) => {
    return anchor.web3.PublicKey.findProgramAddressSync(
      authority? [Buffer.from(seed), authority.toBuffer()] : [Buffer.from(seed)],
      program.programId
    );
  }
  const [lendingMarketPda] = getPda("lending-market");
  const [collateralVaultPda] = getPda("collateral-vault", lendingMarketPda);
  const [loanVaultPda] = getPda("loan-vault", lendingMarketPda);

  let collateralMint, loanMint: anchor.web3.PublicKey;
  before(async () => {
    collateralMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );

    loanMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    ); 
  });

  const initializeLendingMarket = async () => {
    await program.methods.initializeLendingMarket().accounts({
      lendingMarket: lendingMarketPda,
      collateralMint,
      loanMint,
      collateralVault: collateralVaultPda,
      loanVault: loanVaultPda,
      systemProgram: anchor.web3.SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([payer]).rpc();
  }
  
  describe("Initialize Lending Market", () => {
    it("Should fail when collateral and loan mints are the same", async () => {
    let flag = "This should fail";

    try {
      await program.methods.initializeLendingMarket().accounts({
        lendingMarket: lendingMarketPda,
        collateralMint: collateralMint,
        loanMint: collateralMint, // Intentionally using the same mint for both
        collateralVault: collateralVaultPda,
        loanVault: loanVaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([payer]).rpc();

      assert.fail("Should have thrown an error due to identical mints");
      } catch (err) {
        flag = "Failed";
        assert.isTrue(err.toString().includes("Collateral and loan mints cannnot be the same"));
      }
    
      assert.strictEqual(flag, "Failed", "Initialization with identical mints should have failed");
    });

    it("Initializes the lending market", async () => {
      await initializeLendingMarket();

      // Verify the properties of an initial lending market account
      const lendingMarket = await program.account.lendingMarket.fetch(lendingMarketPda);
      assert.ok(lendingMarket.collateralRatioBps === 12000, "Collateral ratio mismatch");
      assert.ok(lendingMarket.interestRateBps === 500, "Interest rate mismatch");
      assert.ok(lendingMarket.collateralMint.equals(collateralMint), "Collateral mint mismatch");
      assert.ok(lendingMarket.loanMint.equals(loanMint), "Loan mint mismatch");
      assert.ok(lendingMarket.collateralVault.equals(collateralVaultPda), "Collteral vault mismatch");
      assert.ok(lendingMarket.loanVault.equals(loanVaultPda), "Loan vault mismatch");

      // Verify the properties of the collateral vault token account
      const collateralVault = await getAccount(provider.connection, collateralVaultPda);
      assert.ok(collateralVault.mint.equals(collateralMint), "Collateral vault's mint ownership mismatch");
      assert.ok(collateralVault.owner.equals(lendingMarketPda), "Collateral vault's owner mismatch");
      assert.equal(collateralVault.amount, BigInt(0), "Initial amount in the collateral vault should be zero");

      // Verify the properties of the loan vault token account
      const loanVault = await getAccount(provider.connection, loanVaultPda);
      assert.ok(loanVault.mint.equals(loanMint));
      assert.ok(loanVault.owner.equals(lendingMarketPda));
      assert.equal(loanVault.amount, BigInt(0), "Initial amount in the loan vault should be zero");
    });

    it("Cannot initialize the lending market twice", async () => {
      let flag = "This should fail";

      try {
        await initializeLendingMarket(); // Attempt to re-initialize the lending market
        assert.fail("Should have thrown an error due to re-initialization");
      }
      catch (err) {
        flag = "Failed";
        assert.isTrue(err.toString().includes("already in use"));
      }
      
      assert.strictEqual(flag, "Failed", "Initializing lending market twice should have failed");
    });
  });

  describe("Create User Account", () => {
    it("Should fail when a malicious user tries to create a user account for another user", async () => {
      const maliciousUser = anchor.web3.Keypair.generate();
      const victimUser = anchor.web3.Keypair.generate();
      const [victimUserAccountPda] = getPda("user-account", victimUser.publicKey);

      let flag = "This should fail";

      try {
        await program.methods.createUserAccount().accounts({
          user: maliciousUser.publicKey,
          userAccount: victimUserAccountPda,
          lendingMarket: lendingMarketPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        }).signers([maliciousUser]).rpc();

        assert.fail("Should have thrown an error due to an unauthorized creation of a user account");
      }
      catch (err) {
        flag = "Failed";
        assert.isTrue(err.message.includes("constraint") || err.message.includes("seeds"), "Expected constraint or seeds error when trying to initialize an account for another user");
      }
      
      assert.strictEqual(flag, "Failed", "A malicious user should not be able to create a user account for another user");
    });

    it("Should succeed when a user creates his or her own user account", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(provider.connection, user.publicKey);
      const [userAccountPda] = getPda("user-account", user.publicKey);

      await program.methods.createUserAccount().accounts({
        user: user.publicKey,
        userAccount: userAccountPda,
        lendingMarket: lendingMarketPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      }).signers([user]).rpc();

      // Verify the properties of the newly created user account
      const userAccount = await program.account.userAccount.fetch(userAccountPda);
      assert.ok(userAccount.user.equals(user.publicKey), "User account's owner mismatch");
      assert.ok(userAccount.lendingMarket.equals(lendingMarketPda), "User account's lending market mismatch");
      assert.ok(userAccount.depositedCollateralAmount.eq(new anchor.BN(0)), "Initial deposited collateral should be zero");
      assert.ok(userAccount.borrowedAmount.eq(new anchor.BN(0)), "Initial borrowed amount should be zero");
    });
  });

  describe("Deposit Collateral", () => {
    it("Should fail when a user tries to transfer some collateral from another user's token account", async () => {
      const victimUser = anchor.web3.Keypair.generate();
      const maliciousUser = anchor.web3.Keypair.generate();
      await airdrop(provider.connection, victimUser.publicKey);
      await airdrop(provider.connection, maliciousUser.publicKey);

      const victimUserAssociatedTokenAccount = await createAssociatedTokenAccount(
        provider.connection,
        victimUser,
        collateralMint,
        victimUser.publicKey
      );

      await mintTo(
        provider.connection,
        payer,
        collateralMint,
        victimUserAssociatedTokenAccount,
        payer,
        1000000000
      );

      const [maliciousUserAccountPda] = getPda("user-account", maliciousUser.publicKey);
      await program.methods.createUserAccount().accounts({
        user: maliciousUser.publicKey,
        userAccount: maliciousUserAccountPda,
        lendingMarket: lendingMarketPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      }).signers([maliciousUser]).rpc();

      let flag = "This should fail";
      try { 
        await program.methods.depositCollateral(new anchor.BN(1000000)).accounts({
          user: maliciousUser.publicKey,
          userAccount: maliciousUserAccountPda,
          lendingMarket: lendingMarketPda,
          userCollateralTokenAccount: victimUserAssociatedTokenAccount, // Maliciously using victim's token account
          collateralVault: collateralVaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        }).signers([maliciousUser]).rpc();

        assert.fail("Should have thrown an error due to an unauthorized collateral deposit");
      } catch (err) {
        flag = "Failed";
        assert.isTrue(err.message.includes("owner does not match"), "Expected ownership error when trying to transfer from another user's token account");
      }

      assert.strictEqual(flag, "Failed", "A malicious user should not be able to deposit collateral from another user's account");
    });

    it("Should succeed when a user deposits collateral from his or her own token account", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(provider.connection, user.publicKey);

      const userAssociatedTokenAccount = await createAssociatedTokenAccount(
        provider.connection,
        user,
        collateralMint,
        user.publicKey
      );

      await mintTo(
        provider.connection,
        payer,
        collateralMint,
        userAssociatedTokenAccount,
        payer,
        1000000000
      );

      const [userAccountPda] = getPda("user-account", user.publicKey);
      await program.methods.createUserAccount().accounts({
        user: user.publicKey,
        userAccount: userAccountPda,
        lendingMarket: lendingMarketPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      }).signers([user]).rpc();

      await program.methods.depositCollateral(new anchor.BN(1000000)).accounts({
        user: user.publicKey,
        userAccount: userAccountPda,
        lendingMarket: lendingMarketPda,
        userCollateralTokenAccount: userAssociatedTokenAccount,
        collateralVault: collateralVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([user]).rpc();

      // Verify the deposited collateral amount in the user account and the lending market after the transfer is successful
      const userAccount = await program.account.userAccount.fetch(userAccountPda);
      const lendingMarket = await program.account.lendingMarket.fetch(lendingMarketPda);
      assert.ok(userAccount.depositedCollateralAmount.eq(new anchor.BN(1000000)), "Deposited collateral amount mismatch");
      assert.ok(lendingMarket.collateralAmount.eq(new anchor.BN(1000000)), "Lending market collateral amount mismatch");
    });
  });

  describe("Borrow Token", () => {
    it("Should fail when a user tries to borrow more than maximum allowable amount based on collateral", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(provider.connection, user.publicKey);

      const userAssociatedTokenAccount = await createAssociatedTokenAccount(
        provider.connection,
        user,
        collateralMint,
        user.publicKey
      );

      await mintTo(
        provider.connection,
        payer,
        collateralMint,
        userAssociatedTokenAccount,
        payer,
        100
      );
      await mintTo(
        provider.connection,
        payer,
        loanMint,
        loanVaultPda,
        payer,
        100000000
      );

      const [userAccountPda] = getPda("user-account", user.publicKey);
      await program.methods.createUserAccount().accounts({
        user: user.publicKey,
        userAccount: userAccountPda,
        lendingMarket: lendingMarketPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      }).signers([user]).rpc();

      await program.methods.depositCollateral(new anchor.BN(100)).accounts({
        user: user.publicKey,
        userAccount: userAccountPda,
        lendingMarket: lendingMarketPda,
        userCollateralTokenAccount: userAssociatedTokenAccount,
        collateralVault: collateralVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([user]).rpc();

      let flag = "This should fail";
      try {
        // Attempt to borrow more than the maximum allowable amount based on the user's deposited collateral
        await program.methods.borrowToken(new anchor.BN(500000)).accounts({
          user: user.publicKey,
          userAccount: userAccountPda,
          lendingMarket: lendingMarketPda,
          userLoanTokenAccount: userAssociatedTokenAccount, // Using the same token account for simplicity
          loanVault: loanVaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        }).signers([user]).rpc();

        assert.fail("Should have thrown an error due to exceeding the maximum allowable borrow amount");
      } catch (err) {
        flag = "Failed";
        assert.isTrue(err.toString().includes("User's total borrow amount will exceed the maximum allowable borrow"), "Expected error for exceeding borrow limit based on collateral");
      }
      
      assert.strictEqual(flag, "Failed", "A user should not be able to borrow more than the maximum allowable amount based on collateral");
    });

    it("Should fail when a user tries to borrow using another user's loan token account", async () => {
      const victimUser = anchor.web3.Keypair.generate();
      const maliciousUser = anchor.web3.Keypair.generate();
      await airdrop(provider.connection, victimUser.publicKey);
      await airdrop(provider.connection, maliciousUser.publicKey);

      const victimUserAssociatedTokenAccount = await createAssociatedTokenAccount(
        provider.connection,
        victimUser,
        collateralMint,
        victimUser.publicKey
      );
      await mintTo(
        provider.connection,
        payer,
        collateralMint,
        victimUserAssociatedTokenAccount,
        payer,
        1000000000
      );
      await mintTo(
        provider.connection,
        payer,
        loanMint,
        loanVaultPda,
        payer,
        1000000000
      );

      const [victimUserAccountPda] = getPda("user-account", victimUser.publicKey);
      await program.methods.createUserAccount().accounts({
        user: victimUser.publicKey,
        userAccount: victimUserAccountPda,
        lendingMarket: lendingMarketPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      }).signers([victimUser]).rpc();
      await program.methods.depositCollateral(new anchor.BN(1000000)).accounts({
        user: victimUser.publicKey,
        userAccount: victimUserAccountPda,
        lendingMarket: lendingMarketPda,
        userCollateralTokenAccount: victimUserAssociatedTokenAccount,
        collateralVault: collateralVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([victimUser]).rpc();

      let firstTryFlag = "This should fail";
      let secondTryFlag = "This should fail too";
      const maliciousUserAssociatedLoanTokenAccount = await createAssociatedTokenAccount(
        provider.connection,
        maliciousUser,
        loanMint,
        maliciousUser.publicKey
      );
      try {
        await program.methods.borrowToken(new anchor.BN(10)).accounts({
          user: maliciousUser.publicKey,
          userAccount: victimUserAccountPda,
          lendingMarket: lendingMarketPda,
          userLoanTokenAccount: maliciousUserAssociatedLoanTokenAccount,
          loanVault: loanVaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        }).signers([maliciousUser]).rpc();
      } catch (err) {
        firstTryFlag = "Failed";
        assert.isTrue(err.message.includes("A has one constraint was violated"), "Expected constraint error when trying to borrow tokens from another user's account");
      }
      try {
        await program.methods.borrowToken(new anchor.BN(10)).accounts({
          user: victimUser.publicKey,
          userAccount: victimUserAccountPda,
          lendingMarket: lendingMarketPda,
          userLoanTokenAccount: maliciousUserAssociatedLoanTokenAccount,
          loanVault: loanVaultPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        }).signers([maliciousUser]).rpc();
      } catch (err) {
        secondTryFlag = "Failed";
        assert.isTrue(err.message.includes("unknown signer"), "Expected constraint error when trying to borrow tokens from another user's account");
      }
    
      assert.strictEqual(firstTryFlag, "Failed", "A user should not be able to borrow using another user's token account");
      assert.strictEqual(secondTryFlag, "Failed", "A user should not be able to borrow using another user's token account");
    });

    it("Should succeed when a user tries to borrow from his or her own account within the maximum allowable borrow amount", async () => {
      const user = anchor.web3.Keypair.generate();
      await airdrop(provider.connection, user.publicKey);

      const userAssociatedCollateralTokenAccount = await createAssociatedTokenAccount(
        provider.connection,
        user,
        collateralMint,
        user.publicKey
      );
      const userAssociatedLoanTokenAccount = await createAssociatedTokenAccount(
        provider.connection,
        user,
        loanMint,
        user.publicKey
      );

      await mintTo(
        provider.connection,
        payer,
        collateralMint,
        userAssociatedCollateralTokenAccount,
        payer,
        1000000000
      );
      await mintTo(
        provider.connection,
        payer,
        loanMint,
        loanVaultPda,
        payer,
        1000000000
      );

      const [userAccountPda] = getPda("user-account", user.publicKey);
      await program.methods.createUserAccount().accounts({
        user: user.publicKey,
        userAccount: userAccountPda,
        lendingMarket: lendingMarketPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      }).signers([user]).rpc();

      await program.methods.depositCollateral(new anchor.BN(1200000)).accounts({
        user: user.publicKey,
        userAccount: userAccountPda,
        lendingMarket: lendingMarketPda,
        userCollateralTokenAccount: userAssociatedCollateralTokenAccount,
        collateralVault: collateralVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([user]).rpc();

      const loanVaultBeforeBorrow = await getAccount(provider.connection, loanVaultPda);
      const borrowAmount = new anchor.BN(1000000); // Within the 120% collateral ratio
      await program.methods.borrowToken(borrowAmount).accounts({
        user: user.publicKey,
        userAccount: userAccountPda,
        lendingMarket: lendingMarketPda,
        userLoanTokenAccount: userAssociatedLoanTokenAccount,
        loanVault: loanVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([user]).rpc();

      const userAccount = await program.account.userAccount.fetch(userAccountPda);
      const lendingMarket = await program.account.lendingMarket.fetch(lendingMarketPda);
      const userLoanAccount = await getAccount(provider.connection, userAssociatedLoanTokenAccount);
      const loanVaultAccount = await getAccount(provider.connection, loanVaultPda);

      assert.ok(userAccount.borrowedAmount.eq(borrowAmount), "User borrowed amount mismatch");
      assert.ok(lendingMarket.borrowedAmount.eq(borrowAmount), "Lending market borrowed amount mismatch");
      assert.equal(userLoanAccount.amount, BigInt(borrowAmount.toNumber()), "Borrowed tokens were not received");

      const loanVaultAfterBorrow = await getAccount(provider.connection, loanVaultPda);
      assert.equal(
        loanVaultAfterBorrow.amount, loanVaultBeforeBorrow.amount - BigInt(borrowAmount.toNumber()),
        "Loan vault amount mismatch after borrow"
      );
    });
  });
});
