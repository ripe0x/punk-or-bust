# FWA V2 hazards

Behaviors of the FWA V2 pool that the vault must handle. Each line cites the verified source in
`refs/fwa-v2/src/FWAV2/FWAV2.sol.txt` or `refs/fwa-v2-rewards/src/FWAV2/FWAV2Rewards.sol.txt`.
Each hazard gets at least one test.

1. **Short purchaser window.** Only the purchaser can settle an allocated listing for
   `settlementWindow` after allocation (source default 24 hours; **live mainnet value 1 hour**
   at block 26,055,939; always read live). After that the depositor can resolve
   it: `depositorReclaimNFT` pays the purchaser the ETH bid, `depositorReclaimBacking` gives the
   purchaser the NFT and keeps the ETH. The depositor picks whichever hurts the purchaser, so every
   miss must settle inside the window.
2. **Finalize.** After `finalizeWindow` (source default 7 days; **live mainnet value 1 hour**)
   anyone can call `finalizeUnsettled`, which sends the NFT to the purchaser. With the live
   values, a miss not settled within an hour of allocation can end up as an NFT in the vault
   instead of ETH, so keepers must sync well inside that hour. The vault can receive NFTs it never chose to keep.
3. **ETH arrives without attribution.** Depositor resolution pays the purchaser with
   `forceSafeTransferETH`, so ETH lands in the vault with no pull id and no callback. The vault
   reconciles by balance, not by events.
4. **Refunds are per address.** Expired, empty-pool and slippage refunds credit
   `acquisitionRefundCredit[purchaser]`, withdrawn in one sum by `withdrawAcquisitionRefund`. There
   is no per-request refund.
5. **Stuck NFTs.** If delivering an NFT fails, the pool records `stuckNFTRecipient[listingId]` and
   only that recipient can later call `recoverStuckNFT`.
6. **Keep can revert.** `keepNFT` delivers strictly; a transfer-restricted or misbehaving
   collection reverts the call, and the purchaser can still take the ETH bid.
7. **Randomness can time out.** A callback after its deadline marks the request `TimedOut`; the
   fee becomes refund credit when the request reaches the head of the queue.
8. **Purchase blackout.** `isPurchaseBlackout()` makes `acquire` revert while callbacks, settlement
   and exits stay open.
9. **Batch limit.** `acquire` takes at most `maxAcquisitionsPerTx` (5 by default) per call.
10. **Builder reward only for a separate caller.** The rewards module gives the builder share to
    the `acquire` caller and gives nothing when the caller is also the purchaser. The allowance is
    FWAT buy credit, claimable only by the caller; ETH withdrawal only works in withdraw-only mode.
11. **Floor oracle is evidence, not liquidity.** `getFloorRange` returns the last accepted
    challenge (or a manual owner override, marked by `periodUsed` outside the valid range). The
    pool itself caps backing at the ask plus 10% and lets anyone kick listings above that cap.
12. **Settlement discount.** The ETH bid pays `settlementDiscountBps` of backing (9,000 by default,
    owner configurable). Read it live; never hard-code it.
