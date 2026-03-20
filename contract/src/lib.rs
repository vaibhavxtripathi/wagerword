#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    Address, Env, String, Vec, token,
};

// Admin sets a hashed secret word. Players pay XLM per guess.
// Guess feedback: CORRECT (right letter, right position),
//                 PRESENT (letter exists, wrong position),
//                 ABSENT  (letter not in word).
// The word is 5 letters. Players get up to 6 guesses.
// Solve within 6 = win the accumulated prize pool.
// All guess fees accumulate. Winner takes all.
// Word hash = ledger-seeded XOR of bytes — simple, on-chain verifiable.

const WORD_LEN:    u32 = 5;
const MAX_GUESSES: u32 = 6;

#[contracttype]
#[derive(Clone, PartialEq)]
pub enum LetterResult { Correct, Present, Absent }

#[contracttype]
#[derive(Clone)]
pub struct GuessResult {
    pub guess:    String,
    pub feedback: Vec<LetterResult>,
    pub correct:  bool,
}

#[contracttype]
#[derive(Clone)]
pub struct PlayerState {
    pub player:      Address,
    pub guess_count: u32,
    pub won:         bool,
    pub guesses:     Vec<GuessResult>,
}

#[contracttype]
#[derive(Clone)]
pub struct GameConfig {
    pub admin:         Address,
    pub xlm_token:     Address,
    pub guess_fee:     i128,
    pub prize_pool:    i128,
    pub round:         u32,         // increments each new word
    pub word_hash:     u64,         // hash of the secret word
    pub total_players: u32,
    pub total_winners: u32,
    pub active:        bool,
}

#[contracttype]
pub enum DataKey {
    Config,
    Player(Address, u32),  // (player, round) → PlayerState
    SecretWord,             // stored separately, admin-only meaningful
}

fn hash_word(word: &[u8]) -> u64 {
    // Simple polynomial hash — deterministic, on-chain verifiable
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in word {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn check_guess(secret: &[u8; 5], guess_bytes: &[u8; 5]) -> [u8; 5] {
    // Returns: 2=Correct, 1=Present, 0=Absent
    let mut result = [0u8; 5];
    let mut secret_used = [false; 5];
    let mut guess_used  = [false; 5];

    // First pass: exact matches
    for i in 0..5 {
        if guess_bytes[i] == secret[i] {
            result[i]      = 2;
            secret_used[i] = true;
            guess_used[i]  = true;
        }
    }
    // Second pass: present (wrong position)
    for i in 0..5 {
        if guess_used[i] { continue; }
        for j in 0..5 {
            if secret_used[j] { continue; }
            if guess_bytes[i] == secret[j] {
                result[i]      = 1;
                secret_used[j] = true;
                break;
            }
        }
    }
    result
}

#[contract]
pub struct WagerWordContract;

#[contractimpl]
impl WagerWordContract {
    /// Admin initializes with a secret word (stored as hash)
    pub fn initialize(
        env: Env,
        admin: Address,
        xlm_token: Address,
        guess_fee: i128,
        secret_word: String,    // stored hashed — admin knows the plaintext
    ) {
        admin.require_auth();
        assert!(!env.storage().instance().has(&DataKey::Config), "Already initialized");
        assert!(guess_fee >= 100_000, "Min fee 0.01 XLM");
        assert!(secret_word.len() == WORD_LEN, "Word must be 5 letters");

        // Copy string bytes using Soroban's copy_into_slice
        let mut arr = [0u8; 5];
        secret_word.copy_into_slice(&mut arr);
        let word_hash = hash_word(&arr);

        // Store the plaintext word for answer checking (admin sets it, players can't read directly)
        env.storage().instance().set(&DataKey::SecretWord, &secret_word);

        let config = GameConfig {
            admin,
            xlm_token,
            guess_fee,
            prize_pool: 0,
            round: 1,
            word_hash,
            total_players: 0,
            total_winners: 0,
            active: true,
        };
        env.storage().instance().set(&DataKey::Config, &config);
    }

    /// Admin sets a new word, starting a new round
    pub fn new_round(env: Env, admin: Address, new_word: String) {
        admin.require_auth();
        let mut config: GameConfig = env.storage().instance()
            .get(&DataKey::Config).expect("Not initialized");
        assert!(config.admin == admin, "Not admin");
        assert!(new_word.len() == WORD_LEN, "Word must be 5 letters");

        let mut arr = [0u8; 5];
        new_word.copy_into_slice(&mut arr);
        config.word_hash = hash_word(&arr);
        config.round    += 1;
        config.active    = true;

        env.storage().instance().set(&DataKey::SecretWord, &new_word);
        env.storage().instance().set(&DataKey::Config, &config);
        env.events().publish((symbol_short!("newround"),), (config.round,));
    }

    /// Player submits a 5-letter guess — costs XLM, returns feedback
    pub fn guess(
        env: Env,
        player: Address,
        word: String,
    ) -> GuessResult {
        player.require_auth();

        let mut config: GameConfig = env.storage().instance()
            .get(&DataKey::Config).expect("Not initialized");
        assert!(config.active, "Game not active");
        assert!(word.len() == WORD_LEN, "Guess must be 5 letters");

        let round = config.round;
        let mut state: PlayerState = env.storage().persistent()
            .get(&DataKey::Player(player.clone(), round))
            .unwrap_or(PlayerState {
                player: player.clone(),
                guess_count: 0,
                won: false,
                guesses: Vec::new(&env),
            });

        assert!(!state.won, "Already solved this round");
        assert!(state.guess_count < MAX_GUESSES, "No guesses remaining");

        // Collect fee
        let token_client = token::Client::new(&env, &config.xlm_token);
        token_client.transfer(&player, &env.current_contract_address(), &config.guess_fee);
        config.prize_pool += config.guess_fee;

        if state.guess_count == 0 {
            config.total_players += 1;
        }

        // Get secret word
        let secret: String = env.storage().instance()
            .get(&DataKey::SecretWord).expect("No word set");
        let mut s_arr = [0u8; 5];
        let mut g_arr = [0u8; 5];
        secret.copy_into_slice(&mut s_arr);
        word.copy_into_slice(&mut g_arr);

        let raw = check_guess(&s_arr, &g_arr);

        let mut feedback = Vec::new(&env);
        for i in 0..5 {
            let lr = match raw[i] {
                2 => LetterResult::Correct,
                1 => LetterResult::Present,
                _ => LetterResult::Absent,
            };
            feedback.push_back(lr);
        }

        let correct = s_arr == g_arr;

        let result = GuessResult { guess: word.clone(), feedback, correct };
        state.guesses.push_back(result.clone());
        state.guess_count += 1;

        if correct {
            state.won = true;
            config.total_winners += 1;
            // Pay out prize pool to winner
            let payout = config.prize_pool;
            config.prize_pool = 0;
            token_client.transfer(&env.current_contract_address(), &player, &payout);
            env.events().publish((symbol_short!("winner"),), (player.clone(), payout, state.guess_count));
        }

        env.storage().persistent().set(&DataKey::Player(player.clone(), round), &state);
        env.storage().instance().set(&DataKey::Config, &config);

        env.events().publish(
            (symbol_short!("guess"),),
            (player, word, correct, state.guess_count),
        );

        result
    }

    // ── Reads ──────────────────────────────────────────────────────────────
    pub fn get_config(env: Env) -> GameConfig {
        env.storage().instance().get(&DataKey::Config).expect("Not initialized")
    }

    pub fn get_player_state(env: Env, player: Address, round: u32) -> Option<PlayerState> {
        env.storage().persistent().get(&DataKey::Player(player, round))
    }

    pub fn get_word_hash(env: Env) -> u64 {
        let config: GameConfig = env.storage().instance()
            .get(&DataKey::Config).expect("Not initialized");
        config.word_hash
    }
}
