/**
 * 马图标:Tabler Icons 的 horse(MIT,https://tabler.io/icons),
 * 描边参数与 lucide 一致(24 画幅 / 2px / 圆角端点)。
 * Harness 板块的导航图标——harness 本义挽具,马是本家。
 */
export function HorseIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="m7 10l-.85 8.507A1.357 1.357 0 0 0 7.5 20h.146a2 2 0 0 0 1.857-1.257l.994-2.486A2 2 0 0 1 12.354 15h1.292a2 2 0 0 1 1.857 1.257l.994 2.486A2 2 0 0 0 18.354 20h.146a1.37 1.37 0 0 0 1.364-1.494L19 9h-8c0-3-3-5-6-5l-3 6l2 2z" />
      <path d="M22 14v-2a3 3 0 0 0-3-3" />
    </svg>
  )
}
