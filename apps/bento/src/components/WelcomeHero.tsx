/**
 * 新会话欢迎语(方案 J,原型见 prototypes/welcome-hero-demo):
 * 便当三格拼装入场 → Plus Jakarta Sans 逐字弹簧 → 入场时琥珀色接力波扫过一次。
 * logo 几何与 public/bento-logo.png 同源(四格便当:左通高格 + 右上琥珀格 + 右下格,
 * 512 基准网格等比缩放到 100 viewBox)。
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
        <rect className="welcome-logo-block welcome-logo-block-l" x="21.9" y="21.9" width="25.8" height="56.2" rx="7" />
        <rect className="welcome-logo-block welcome-logo-block-t" x="52.3" y="21.9" width="25.8" height="25.8" rx="7" />
        <rect className="welcome-logo-block welcome-logo-block-b" x="52.3" y="52.3" width="25.8" height="25.8" rx="7" />
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
