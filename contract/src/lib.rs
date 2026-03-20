#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    Address, Bytes, Env, String, Vec, token,
};

// Admin sets a secret 5-letter word. Players pay XLM per guess.
// Guess feedback: Correct (right pos), Present (wrong pos), Absent.
// Up to 6 guesses. Solver wins the accumulated prize pool.

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
    pub round:         u32,
    pub word_hash:     u64,
    pub total_players: u32,
    pub total_winners: u32,
    pub active:        bool,
}

#[contracttype]
pub enum DataKey {
    Config,
    Player(Address, u32),
    SecretWord,
}

fn hash_word(word: &[u8; 5]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in word {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn check_guess(secret: &[u8; 5], guess: &[u8; 5]) -> [u8; 5] {
    let mut result       = [0u8; 5];
    let mut secret_used  = [false; 5];
    let mut guess_used   = [false; 5];
    // Exact matches first
    for i in 0..5 {
        if guess[i] == secret[i] {
            result[i]      = 2;
            secret_used[i] = true;
            guess_used[i]  = true;
        }
    }
    // Present (wrong position)
    for i in 0..5 {
        if guess_used[i] { continue; }
        for j in 0..5 {
            if secret_used[j] { continue; }
            if guess[i] == secret[j] {
                result[i]      = 1;
                secret_used[j] = true;
                break;
            }
        }
    }
    result
}

fn word_to_arr(bytes: &Bytes) -> [u8; 5] {
    let mut arr = [0u8; 5];
    for i in 0..5u32 {
        arr[i as usize] = bytes.get(i).unwrap();
    }
    arr
}

#[contract]
pub struct WagerWordContract;

#[contractimpl]
impl WagerWordContract {
    /// Admin initializes the game with a 5-letter secret word
    pub fn initialize(
        env: Env,
        admin: Address,
        xlm_token: Address,
        guess_fee: i128,
        secret_word: String,
    ) {
        admin.require_auth();
        assert!(!env.storage().instance().has(&DataKey::Config));
        assert!(guess_fee >= 100_000);
        assert!(secret_word.len() == WORD_LEN);

        let bytes = secret_word.to_bytes();
        let arr   = word_to_arr(&bytes);
        let word_hash = hash_word(&arr);

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

    /// Admin starts a new round with a fresh word
    pub fn new_round(env: Env, admin: Address, new_word: String) {
        admin.require_auth();
        let mut config: GameConfig = env.storage().instance()
            .get(&DataKey::Config).expect("Not initialized");
        assert!(config.admin == admin);
        assert!(new_word.len() == WORD_LEN);

        let bytes = new_word.to_bytes();
        let arr   = word_to_arr(&bytes);
        config.word_hash = hash_word(&arr);
        config.round    += 1;
        config.active    = true;

        env.storage().instance().set(&DataKey::SecretWord, &new_word);
        env.storage().instance().set(&DataKey::Config, &config);
        env.events().publish((symbol_short!("newround"),), (config.round,));
    }

    /// Player submits a 5-letter guess — costs XLM, returns feedback
    pub fn guess(env: Env, player: Address, word: String) -> GuessResult {
        player.require_auth();

        let mut config: GameConfig = env.storage().instance()
            .get(&DataKey::Config).expect("Not initialized");
        assert!(config.active);
        assert!(word.len() == WORD_LEN);

        let round = config.round;
        let mut state: PlayerState = env.storage().persistent()
            .get(&DataKey::Player(player.clone(), round))
            .unwrap_or(PlayerState {
                player: player.clone(),
                guess_count: 0,
                won: false,
                guesses: Vec::new(&env),
            });

        assert!(!state.won);
        assert!(state.guess_count < MAX_GUESSES);

        // Collect guess fee
        let token_client = token::Client::new(&env, &config.xlm_token);
        token_client.transfer(&player, &env.current_contract_address(), &config.guess_fee);
        config.prize_pool += config.guess_fee;

        if state.guess_count == 0 {
            config.total_players += 1;
        }

        // Compare guess to secret word
        let secret: String = env.storage().instance()
            .get(&DataKey::SecretWord).expect("No word set");
        let s_bytes = secret.to_bytes();
        let w_bytes = word.to_bytes();
        let s_arr = word_to_arr(&s_bytes);
        let w_arr = word_to_arr(&w_bytes);

        let raw = check_guess(&s_arr, &w_arr);

        let mut feedback = Vec::new(&env);
        for i in 0..5usize {
            let lr = match raw[i] {
                2 => LetterResult::Correct,
                1 => LetterResult::Present,
                _ => LetterResult::Absent,
            };
            feedback.push_back(lr);
        }

        let correct = s_bytes == w_bytes;
        let result  = GuessResult { guess: word.clone(), feedback, correct };
        state.guesses.push_back(result.clone());
        state.guess_count += 1;

        if correct {
            state.won = true;
            config.total_winners += 1;
            let payout = config.prize_pool;
            config.prize_pool = 0;
            token_client.transfer(&env.current_contract_address(), &player, &payout);
            env.events().publish(
                (symbol_short!("winner"),),
                (player.clone(), payout, state.guess_count),
            );
        }

        env.storage().persistent().set(&DataKey::Player(player.clone(), round), &state);
        env.storage().instance().set(&DataKey::Config, &config);
        env.events().publish(
            (symbol_short!("guess"),),
            (player, word, correct, state.guess_count),
        );
        result
    }

    // ── Reads ─────────────────────────────────────────────────────────────────
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
