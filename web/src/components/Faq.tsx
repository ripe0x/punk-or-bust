const ITEMS: { q: string; a: string }[] = [
  {
    q: 'What is Punk or Bust?',
    a: 'A personal vault that pulls NFTs from the FWA V2 pool for you. Fund it with ETH and pick what to keep. It pulls over and over: anything on your keep list goes to your wallet, everything else sells back to the pool (or runs a short auction first), and that ETH recycles into more pulls until a stop condition, then the rest returns to you.',
  },
  {
    q: 'What is a pull?',
    a: 'One random draw from the pool at the current price. Each pull either matches your keep list, so you keep it, or is a miss, so it sells back or auctions.',
  },
  {
    q: 'How do I choose what to keep?',
    a: 'In Set up a run, pick whole collections or specific token IDs. Those are your targets. Pull one and it goes to your wallet; anything else is sold back to fund more pulls. You can change the keep list any time, even mid-run.',
  },
  {
    q: 'What happens to pulls I do not keep?',
    a: 'They sell back to FWA for ETH, which recycles into more pulls. If the floor oracle says a miss is worth clearly more than its sell-back price, it runs a short auction first to try to capture that value.',
  },
  {
    q: 'When does a miss go to auction instead of selling back?',
    a: 'Only when a fresh floor reading is at least 9% and at least 0.01 ETH above the sell-back price. Otherwise it sells back. An auction with no bids just settles at the sell-back price, so there is no downside to trying.',
  },
  {
    q: 'Can I close an auction early?',
    a: 'No. An auction runs 30 minutes, extendable to 60 by late bids, then anyone can finalize it. A no-bid auction settles at the sell-back price once its time is up.',
  },
  {
    q: 'Are the auction rules configurable?',
    a: 'No. The trigger thresholds, durations, and the 8 concurrent-auction limit are fixed for every vault. The only lever you have over auctions is the keep list, since kept items never auction.',
  },
  {
    q: 'What does "Finishing up" mean?',
    a: 'Your run stopped taking new pulls, from a stop condition or because you pressed Stop, but its open pulls and auctions are still resolving. When the last one settles, the vault goes idle and you can start a new run.',
  },
  {
    q: 'What are rounds?',
    a: 'Each run is a round. A new run starts fresh and never inherits the previous round’s pulls or its pull count. Past rounds stay in your feed, grouped separately, newest first.',
  },
  {
    q: 'Why can I only run one at a time?',
    a: 'You have one vault, tied to your address. A run is a session on it, and its limits, drawdown, pull cap, deadline, all measure against the vault’s single balance. Stop or finish the current run, then start another.',
  },
  {
    q: 'What is the pull cap for?',
    a: 'It bounds the number of draws, so a run that keeps winning and never hits its drawdown floor still ends. With the deadline it guarantees the run terminates. It defaults to 1000; change it under More settings.',
  },
  {
    q: 'Which settings can I change mid-run?',
    a: 'Keep list, approved keepers, gas ceiling, bounties, auto-return, and private mode, any time. A run’s drawdown, max pull cost, stop-after-keeps, deadline and max pulls are fixed for that run.',
  },
  {
    q: 'Where does my kept NFT go?',
    a: 'Straight to your wallet the moment it is kept. Its value counts toward your run, and the card marks it kept rather than showing a profit number, since you hold the NFT.',
  },
  {
    q: 'What does it cost?',
    a: 'A 0.025% fee on each completed pull’s price. Anyone can run the keeper calls that make pulls, sync results and finalize auctions; when they do useful work for your vault it reimburses their gas plus a small bounty from your funds.',
  },
  {
    q: 'What stops a run?',
    a: 'Any of: your drawdown floor, your keep target, the deadline, the pull cap, a pull quote above your max pull cost, or pressing Stop.',
  },
];

export function Faq() {
  return (
    <div className="faq">
      <h1 className="form-heading">Questions</h1>
      <p className="lede">How pulls, keeps, auctions and runs work.</p>
      <div className="faq-list">
        {ITEMS.map((it) => (
          <details key={it.q} className="faq-item">
            <summary>{it.q}</summary>
            <p>{it.a}</p>
          </details>
        ))}
      </div>
    </div>
  );
}
