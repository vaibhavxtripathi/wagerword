# WagerWord

Wordle on Stellar. Guess the hidden 5-letter word in up to 6 tries. Each guess costs XLM and adds to the prize pool. Solve it and take the entire pot. Admin sets the word and can rotate it each round.

## Live Links

| | |
|---|---|
| **Frontend** | `https://wagerword.vercel.app` |
| **Contract** | `https://stellar.expert/explorer/testnet/contract/CALU7PDY6AK5CFZ23EPDSJGAS7ETY54DA7KXWLHTZCLZD5EHLOUTLINA` |

## How It Works

1. Admin calls `initialize()` with a secret 5-letter word (stored as polynomial hash)
2. Players call `guess(word)` — pays XLM fee, gets letter feedback
3. Feedback per letter: **Correct** (right position), **Present** (wrong position), **Absent**
4. First player to guess correctly wins the entire accumulated prize pool
5. Admin calls `new_round()` to set a new word for the next game

## Scoring Algorithm

```rust
// Polynomial hash: FNV-1a inspired
fn hash_word(word: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in word { h ^= b as u64; h = h.wrapping_mul(0x100000001b3); }
    h
}

// Guess feedback: two-pass algorithm (exact → present)
```

## Contract Functions

```rust
initialize(admin, xlm_token, guess_fee: i128, secret_word)
new_round(admin, new_word)              // set new word, increment round
guess(player, word) -> GuessResult     // pays fee, returns letter feedback
get_config() -> GameConfig
get_player_state(player, round) -> Option<PlayerState>
get_word_hash() -> u64
```

## Stack

| Layer | Tech |
|---|---|
| Contract | Rust + Soroban SDK v22 |
| Network | Stellar Testnet |
| Frontend | React 18 + Vite |
| Wallet | Freighter API 6.0.1 |
| Stellar SDK | 14.6.1 |
| Hosting | Vercel |

## Run Locally

```bash
chmod +x scripts/deploy.sh && ./scripts/deploy.sh
cd frontend && npm install && npm run dev
```
