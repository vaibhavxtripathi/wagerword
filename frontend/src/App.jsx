import { useState, useEffect, useRef } from 'react'
import {
  connectWallet, submitGuess, setNewRound, getConfig, getPlayerState,
  xlm, short, CONTRACT_ID, ADMIN_ADDRESS,
} from './lib/stellar'

const WORD_LEN    = 5
const MAX_GUESSES = 6

// ── Letter tile ────────────────────────────────────────────────────────────
function Tile({ letter, state, animDelay = 0 }) {
  const cls = {
    correct: 'tile-correct',
    present: 'tile-present',
    absent:  'tile-absent',
    filled:  'tile-filled',
    empty:   'tile-empty',
    active:  'tile-active',
  }[state] || 'tile-empty'

  return (
    <div
      className={`tile ${cls}`}
      style={state === 'correct' || state === 'present' || state === 'absent'
        ? { animationDelay: `${animDelay * 100}ms` }
        : {}
      }
    >
      {letter}
    </div>
  )
}

// ── Row ────────────────────────────────────────────────────────────────────
function GuessRow({ letters, feedback, isActive, shake }) {
  const tiles = Array.from({ length: WORD_LEN }, (_, i) => {
    const letter = letters[i] || ''
    let state = 'empty'
    if (feedback) {
      state = ['absent', 'present', 'correct'][feedback[i]] ?? 'absent'
    } else if (letter) {
      state = isActive ? 'active' : 'filled'
    }
    return { letter, state }
  })

  return (
    <div className={`guess-row ${shake ? 'row-shake' : ''} ${feedback ? 'row-flip' : ''}`}>
      {tiles.map((t, i) => (
        <Tile key={i} letter={t.letter.toUpperCase()} state={t.state} animDelay={i} />
      ))}
    </div>
  )
}

// ── Keyboard ───────────────────────────────────────────────────────────────
const ROWS = [
  ['Q','W','E','R','T','Y','U','I','O','P'],
  ['A','S','D','F','G','H','J','K','L'],
  ['ENTER','Z','X','C','V','B','N','M','⌫'],
]

function Keyboard({ letterStates, onKey, disabled }) {
  return (
    <div className="keyboard">
      {ROWS.map((row, ri) => (
        <div key={ri} className="kb-row">
          {row.map(k => {
            const st = letterStates[k] || ''
            const cls = { correct:'kb-correct', present:'kb-present', absent:'kb-absent' }[st] || ''
            const wide = k === 'ENTER' || k === '⌫'
            return (
              <button key={k}
                className={`kb-key ${cls} ${wide ? 'kb-wide' : ''}`}
                onClick={() => !disabled && onKey(k)}
                disabled={disabled}>
                {k}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

// ── Admin new round form ───────────────────────────────────────────────────
function NewRoundForm({ wallet, onSet }) {
  const [word, setWord] = useState('')
  const [busy, setBusy] = useState(false)
  const [err,  setErr]  = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (word.length !== 5) { setErr('Word must be exactly 5 letters'); return }
    setBusy(true); setErr('')
    try {
      const hash = await setNewRound(wallet, word)
      onSet(hash, word)
      setWord('')
    } catch (e) { setErr(e.message) }
    finally { setBusy(false) }
  }

  return (
    <form className="new-round-form" onSubmit={handleSubmit}>
      <div className="nrf-title">SET NEW WORD</div>
      <div className="nrf-row">
        <input
          value={word}
          onChange={e => setWord(e.target.value.toLowerCase().replace(/[^a-z]/g,'').slice(0,5))}
          placeholder="5-letter word"
          maxLength={5} required disabled={busy}
          className="nrf-input"
        />
        <button type="submit" className="nrf-btn" disabled={busy || word.length !== 5}>
          {busy ? '…' : 'Set'}
        </button>
      </div>
      {err && <p className="nrf-err">{err}</p>}
    </form>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────
export default function App() {
  const [wallet,       setWallet]       = useState(null)
  const [config,       setConfig]       = useState(null)
  const [playerState,  setPlayerState]  = useState(null)
  const [currentGuess, setCurrentGuess] = useState('')
  const [guesses,      setGuesses]      = useState([])   // [{letters, feedback}]
  const [letterStates, setLetterStates] = useState({})
  const [gameOver,     setGameOver]     = useState(false)
  const [won,          setWon]          = useState(false)
  const [shake,        setShake]        = useState(false)
  const [toast,        setToast]        = useState(null)
  const [submitting,   setSubmitting]   = useState(false)
  const [showAdmin,    setShowAdmin]    = useState(false)
  const isAdmin = wallet && wallet === ADMIN_ADDRESS

  const loadConfig = async () => {
    const cfg = await getConfig()
    setConfig(cfg)
    return cfg
  }

  const loadPlayerState = async (addr, round) => {
    const ps = await getPlayerState(addr, round)
    if (!ps) return
    setPlayerState(ps)

    // Reconstruct local guess state from on-chain history
    const newGuesses = []
    const newLetterStates = {}
    for (const g of ps.guesses) {
      const letters = g.guess ? g.guess.toString().split('') : []
      const fb = Array.isArray(g.feedback) ? g.feedback.map(f => {
        if (f === 'Correct') return 2
        if (f === 'Present') return 1
        return 0
      }) : []
      newGuesses.push({ letters, feedback: fb })
      // Update letter states (correct > present > absent priority)
      letters.forEach((l, i) => {
        const key = l.toUpperCase()
        const cur = newLetterStates[key]
        const val = ['absent','present','correct'][fb[i]] || 'absent'
        if (!cur || (cur === 'absent') || (cur === 'present' && val === 'correct')) {
          newLetterStates[key] = val
        }
      })
    }
    setGuesses(newGuesses)
    setLetterStates(newLetterStates)
    if (ps.won) { setWon(true); setGameOver(true) }
    if (!ps.won && ps.guess_count >= MAX_GUESSES) setGameOver(true)
  }

  useEffect(() => { loadConfig() }, [])
  useEffect(() => {
    if (wallet && config) loadPlayerState(wallet, Number(config.round))
  }, [wallet, config?.round])

  const handleConnect = async () => {
    try { setWallet(await connectWallet()) }
    catch (e) { showMsg(e.message, false) }
  }

  const showMsg = (msg, ok = true, hash) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 5000)
  }

  const handleKey = (key) => {
    if (gameOver || submitting) return
    if (key === '⌫' || key === 'BACKSPACE') {
      setCurrentGuess(g => g.slice(0, -1))
    } else if (key === 'ENTER') {
      handleSubmit()
    } else if (/^[A-Z]$/.test(key) && currentGuess.length < WORD_LEN) {
      setCurrentGuess(g => g + key.toLowerCase())
    }
  }

  useEffect(() => {
    const handler = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'Backspace') handleKey('⌫')
      else if (e.key === 'Enter') handleKey('ENTER')
      else if (/^[a-zA-Z]$/.test(e.key)) handleKey(e.key.toUpperCase())
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [currentGuess, gameOver, submitting])

  const handleSubmit = async () => {
    if (!wallet) { showMsg('Connect wallet first', false); return }
    if (currentGuess.length !== WORD_LEN) {
      setShake(true); setTimeout(() => setShake(false), 400)
      showMsg('Word must be 5 letters', false); return
    }
    if (!config) return

    setSubmitting(true)
    try {
      const { hash, guessResult } = await submitGuess(
        wallet, currentGuess, Number(config.guess_fee)
      )

      // If we got the result from the TX, use it; otherwise reload from chain
      let fb = []
      let correct = false
      if (guessResult && guessResult.feedback) {
        fb = guessResult.feedback.map(f => {
          if (f === 'Correct') return 2
          if (f === 'Present') return 1
          return 0
        })
        correct = guessResult.correct
      } else {
        // Reload from chain
        await loadPlayerState(wallet, Number(config.round))
        setCurrentGuess('')
        setSubmitting(false)
        return
      }

      const letters = currentGuess.split('')
      const newGuesses = [...guesses, { letters, feedback: fb }]
      setGuesses(newGuesses)

      // Update letter states
      const newLS = { ...letterStates }
      letters.forEach((l, i) => {
        const key = l.toUpperCase()
        const val = ['absent','present','correct'][fb[i]] || 'absent'
        const cur = newLS[key]
        if (!cur || (cur === 'absent') || (cur === 'present' && val === 'correct')) {
          newLS[key] = val
        }
      })
      setLetterStates(newLS)

      if (correct) {
        setWon(true); setGameOver(true)
        showMsg(`🎉 You won ${xlm(config.prize_pool + config.guess_fee)} XLM!`, true, hash)
      } else if (newGuesses.length >= MAX_GUESSES) {
        setGameOver(true)
        showMsg('No more guesses. Better luck next round!', false)
      } else {
        showMsg(`Guess ${newGuesses.length}/6 — ${xlm(config.guess_fee)} XLM spent`, true, hash)
      }

      setCurrentGuess('')
      loadConfig()
    } catch (e) { showMsg(e.message, false) }
    finally { setSubmitting(false) }
  }

  const guessFeePct = config ? Number(config.guess_fee) / 10_000_000 : 0
  const guessesLeft = MAX_GUESSES - guesses.length

  // Build grid rows
  const rows = Array.from({ length: MAX_GUESSES }, (_, i) => {
    if (i < guesses.length) return guesses[i]
    if (i === guesses.length) return { letters: currentGuess.split(''), feedback: null, active: true }
    return { letters: [], feedback: null, active: false }
  })

  return (
    <div className="app">
      {/* ── Header ── */}
      <header className="header">
        <div className="brand">
          <span className="brand-w">W</span>
          <div>
            <div className="brand-name">WagerWord</div>
            <div className="brand-sub">5 letters · 6 guesses · XLM at stake</div>
          </div>
        </div>

        <div className="header-center">
          <div className="prize-display">
            <div className="pd-label">PRIZE POOL</div>
            <div className="pd-amount">{xlm(config?.prize_pool || 0)}</div>
            <div className="pd-unit">XLM</div>
          </div>
          <div className="hc-sep"/>
          <div className="prize-display">
            <div className="pd-label">PER GUESS</div>
            <div className="pd-amount">{xlm(config?.guess_fee || 0)}</div>
            <div className="pd-unit">XLM</div>
          </div>
          <div className="hc-sep"/>
          <div className="prize-display">
            <div className="pd-label">ROUND</div>
            <div className="pd-amount">{config?.round?.toString() || '1'}</div>
            <div className="pd-unit">ROUND</div>
          </div>
        </div>

        <div className="header-right">
          {isAdmin && (
            <button className="btn-admin" onClick={() => setShowAdmin(s => !s)}>
              Admin
            </button>
          )}
          {wallet
            ? <div className="wallet-pill"><span className="wdot"/>{short(wallet)}</div>
            : <button className="btn-connect" onClick={handleConnect}>Connect</button>
          }
        </div>
      </header>

      {/* ── Admin panel ── */}
      {showAdmin && isAdmin && (
        <div className="admin-bar">
          <NewRoundForm wallet={wallet} onSet={(hash, word) => {
            showMsg(`New word "${word}" set!`, true, hash)
            setGuesses([]); setCurrentGuess(''); setLetterStates({})
            setGameOver(false); setWon(false)
            loadConfig()
          }} />
        </div>
      )}

      {/* ── Toast ── */}
      {toast && (
        <div className={`toast ${toast.ok ? 'toast-ok' : 'toast-err'}`}>
          <span>{toast.msg}</span>
          {toast.hash && (
            <a href={`https://stellar.expert/explorer/testnet/tx/${toast.hash}`}
              target="_blank" rel="noreferrer" className="toast-link">TX ↗</a>
          )}
        </div>
      )}

      <main className="main">
        {/* ── Connect gate ── */}
        {!wallet && (
          <div className="connect-gate">
            <div className="cg-board">
              {['W','A','G','E','R'].map((l,i) => (
                <div key={i} className={`cg-tile ct-${i}`}>{l}</div>
              ))}
            </div>
            <h2 className="cg-title">Guess the word. Win the pot.</h2>
            <p className="cg-sub">
              Each guess costs {xlm(config?.guess_fee || 5000000)} XLM and adds to the prize pool.
              Solve in 6 tries to take it all home.
            </p>
            <button className="btn-connect-lg" onClick={handleConnect}>
              Connect Freighter to Play
            </button>
            <a className="cg-contract"
              href={`https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}`}
              target="_blank" rel="noreferrer">View Contract ↗</a>
          </div>
        )}

        {/* ── Game ── */}
        {wallet && (
          <div className="game-wrap">
            {/* Game status */}
            <div className="game-status">
              {gameOver && won && (
                <div className="gs-won">🎉 You solved it! Prize sent to your wallet.</div>
              )}
              {gameOver && !won && (
                <div className="gs-lost">Game over — wait for the next round.</div>
              )}
              {!gameOver && (
                <div className="gs-info">
                  <span>{guessesLeft} guess{guessesLeft !== 1 ? 'es' : ''} left</span>
                  <span>·</span>
                  <span>{xlm(config?.guess_fee || 0)} XLM per guess</span>
                  <span>·</span>
                  <span>{xlm(config?.prize_pool || 0)} XLM pool</span>
                </div>
              )}
            </div>

            {/* Grid */}
            <div className="game-grid">
              {rows.map((row, i) => (
                <GuessRow
                  key={i}
                  letters={row.letters}
                  feedback={row.feedback}
                  isActive={row.active}
                  shake={shake && i === guesses.length}
                />
              ))}
            </div>

            {/* Submit button */}
            {!gameOver && (
              <button
                className={`btn-submit ${submitting ? 'btn-submitting' : ''}`}
                onClick={handleSubmit}
                disabled={submitting || currentGuess.length !== WORD_LEN || !config?.active}>
                {submitting
                  ? 'Signing on Stellar…'
                  : currentGuess.length === WORD_LEN
                    ? `Submit Guess · ${xlm(config?.guess_fee || 0)} XLM`
                    : `Type ${WORD_LEN - currentGuess.length} more letter${WORD_LEN - currentGuess.length !== 1 ? 's' : ''}`
                }
              </button>
            )}

            {/* Keyboard */}
            <Keyboard
              letterStates={letterStates}
              onKey={handleKey}
              disabled={gameOver || submitting || !config?.active}
            />

            {/* Stats row */}
            <div className="game-stats-row">
              <div className="gsr">
                <span className="gsr-n">{config?.total_players?.toString() || '0'}</span>
                <span className="gsr-l">Players this round</span>
              </div>
              <div className="gsr">
                <span className="gsr-n">{config?.total_winners?.toString() || '0'}</span>
                <span className="gsr-l">Total winners</span>
              </div>
              <div className="gsr">
                <span className="gsr-n">{guesses.length}/{MAX_GUESSES}</span>
                <span className="gsr-l">Guesses used</span>
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="footer">
        <span>WagerWord · Stellar Testnet · Soroban</span>
        <a href={`https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}`}
          target="_blank" rel="noreferrer">Contract ↗</a>
      </footer>
    </div>
  )
}
