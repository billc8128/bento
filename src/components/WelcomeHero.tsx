/**
 * 新会话欢迎语(方案 J,原型见 prototypes/welcome-hero-demo):
 * 便当三格拼装入场 → Plus Jakarta Sans 逐字弹簧 → 琥珀色接力波周期扫过。
 * logo 几何按 public/bento-logo.png 实测校准(左竖条 + 右琥珀/深色块,右端半圆)。
 */
const WELCOME_TITLE = "Have fun with Bento"
const WORDS = WELCOME_TITLE.split(" ")
const CHAR_BASE_MS = 550 // 等 logo 三格拼完再起字
const CHAR_STAGGER_MS = 38
const WAVE_LAG_MS = 700 // 字母落定后琥珀波接力

export function WelcomeHero() {
  let charIndex = 0
  return (
    <div className="welcome-hero mb-[var(--app-onboarding-title-gap)] flex items-center justify-center gap-3 sm:gap-4">
      <svg viewBox="0 0 100 100" className="welcome-logo size-10 shrink-0 sm:size-12" aria-hidden>
        <rect className="welcome-logo-block welcome-logo-block-l" x="18.7" y="18.7" width="17" height="58.8" rx="4.5" />
        <path
          className="welcome-logo-block welcome-logo-block-t"
          d="M43.4 26.1 H69.55 A12.05 12.05 0 0 1 69.55 50.2 H43.4 A3 3 0 0 1 40.4 47.2 V29.1 A3 3 0 0 1 43.4 26.1 Z"
        />
        <path
          className="welcome-logo-block welcome-logo-block-b"
          d="M43.4 52 H68.85 A12.75 12.75 0 0 1 68.85 77.5 H43.4 A3 3 0 0 1 40.4 74.5 V55 A3 3 0 0 1 43.4 52 Z"
        />
      </svg>
      <h1 className="welcome-title type-display">
        {WORDS.map((word, wi) => (
          <span key={wi} className="welcome-word">
            {[...word].map((ch) => {
              const enter = CHAR_BASE_MS + charIndex * CHAR_STAGGER_MS
              const wave = enter + WAVE_LAG_MS
              charIndex += 1
              return (
                <span key={charIndex} className="welcome-char" style={{ animationDelay: `${enter}ms, ${wave}ms` }}>
                  {ch}
                </span>
              )
            })}
            {wi < WORDS.length - 1 ? " " : null}
          </span>
        ))}
      </h1>
    </div>
  )
}
