/**
 * 账户板块:显示名 + 头像。纯本地资料,没有账户系统;
 * 头像选图后缩到 128px 存 dataURL,不出本机。
 */

import { useEffect, useRef, useState } from "react"
import { ArrowDownToLine, ArrowUpToLine, Check, CircleUserRound, RotateCw, Trash2, TriangleAlert } from "lucide-react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useT, type TFn } from "@/lib/i18n"
import { profileInitial, setProfile, useProfile } from "@/lib/profile-store"
import type { AppUpdateState } from "@/core/app-update"

/** 选图 → 方形居中裁 128px → JPEG dataURL(localStorage 友好) */
function readAvatar(file: File, t: TFn): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const side = Math.min(img.width, img.height)
      const canvas = document.createElement("canvas")
      canvas.width = 128
      canvas.height = 128
      canvas
        .getContext("2d")!
        .drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 128, 128)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL("image/jpeg", 0.85))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(t("settings.avatarReadFailed")))
    }
    img.src = url
  })
}

export function AccountSection() {
  const profile = useProfile()
  const fileRef = useRef<HTMLInputElement>(null)
  const { t } = useT()
  const [update, setUpdate] = useState<AppUpdateState | null>(null)
  /** 手动检查完且没有新版本时给一句「已是最新」,几秒后隐去;后台周期检查不抢这句话 */
  const [justChecked, setJustChecked] = useState(false)
  const manualCheck = useRef(false)
  const prevStatus = useRef<AppUpdateState["status"] | undefined>(undefined)

  useEffect(() => {
    const api = window.bento
    if (!api) return
    let active = true
    let receivedEvent = false
    const unsubscribe = api.onAppUpdate((next) => {
      receivedEvent = true
      if (manualCheck.current && prevStatus.current === "checking" && next.status === "idle") {
        setJustChecked(true)
        manualCheck.current = false
      }
      prevStatus.current = next.status
      setUpdate(next)
    })
    void api.getAppUpdate().then((next) => {
      if (active && !receivedEvent) {
        prevStatus.current = next.status
        setUpdate(next)
      }
    }).catch(() => {})
    return () => { active = false; unsubscribe() }
  }, [])

  useEffect(() => {
    if (!justChecked) return
    const timer = setTimeout(() => setJustChecked(false), 4000)
    return () => clearTimeout(timer)
  }, [justChecked])

  const checkForUpdates = () => {
    manualCheck.current = true
    void window.bento?.checkAppUpdate().catch(() => {})
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 rounded-xl border border-border px-4 py-4">
        <button
          type="button"
          title={t("settings.changeAvatar")}
          onClick={() => fileRef.current?.click()}
          className="group relative shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Avatar className="size-14">
            {profile.avatar && <AvatarImage src={profile.avatar} />}
            <AvatarFallback className="bg-primary/15 text-lg font-semibold">
              {profile.avatar ? null : profileInitial(profile.name)}
            </AvatarFallback>
          </Avatar>
          <span className="absolute inset-0 grid place-items-center rounded-full bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
            <CircleUserRound className="size-5 text-white" />
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void readAvatar(file, t).then((avatar) => setProfile({ avatar }))
            e.target.value = ""
          }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-sm font-medium">{t("settings.displayName")}</span>
          <Input
            key={profile.name}
            defaultValue={profile.name}
            maxLength={24}
            onBlur={(e) => setProfile({ name: e.target.value })}
            className="h-8 max-w-56 text-sm"
          />
        </div>
        {profile.avatar && (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            onClick={() => setProfile({ avatar: null })}
          >
            <Trash2 className="size-3.5" />
            {t("settings.removeAvatar")}
          </Button>
        )}
      </div>
      {update && (
        <div className="flex h-7 items-center gap-2 px-1 text-xs text-muted-foreground">
          <span>Bento · {t("settings.appVersion", { version: update.currentVersion })}</span>
          {update.status === "idle" &&
            (justChecked ? (
              <span className="inline-flex h-5 items-center gap-1 rounded-full bg-ok/10 px-2 text-[11px] font-medium text-ok">
                <Check className="size-3" />
                {t("settings.updateLatest")}
              </span>
            ) : (
              <button
                type="button"
                onClick={checkForUpdates}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <RotateCw className="size-3" />
                {t("settings.checkUpdate")}
              </button>
            ))}
          {update.status === "checking" && (
            <span className="inline-flex h-5 items-center gap-1 rounded-full bg-muted px-2 text-[11px] font-medium text-muted-foreground">
              <RotateCw className="size-3 animate-spin motion-reduce:animate-none" />
              {t("settings.updateChecking")}
            </span>
          )}
          {update.status === "available" && update.version && (
            <>
              <span className="inline-flex h-5 items-center gap-1 rounded-full bg-brand/12 px-2 text-[11px] font-medium text-brand">
                <ArrowUpToLine className="size-3" />
                {t("settings.updateAvailable", { version: update.version })}
              </span>
              <Button
                size="sm"
                className="h-6 px-2 text-xs"
                title={t("sidebar.update.available", { version: update.version })}
                onClick={() => void window.bento?.downloadAppUpdate()}
              >
                {t("settings.updateNow")}
              </Button>
            </>
          )}
          {update.status === "downloading" && (
            <span className="inline-flex h-5 items-center gap-1.5 rounded-full bg-brand/12 px-2 text-[11px] font-medium text-brand">
              <ArrowDownToLine className="size-3" />
              <span className="relative h-1 w-16 overflow-hidden rounded-full bg-brand/20">
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-brand transition-[width] duration-200 motion-reduce:transition-none"
                  style={{ width: `${update.percent}%` }}
                />
              </span>
              <span className="tabular-nums">{Math.floor(update.percent)}%</span>
            </span>
          )}
          {(update.status === "downloaded" || update.status === "installing") && (
            <span className="inline-flex h-5 items-center gap-1 rounded-full bg-brand/12 px-2 text-[11px] font-medium text-brand">
              <RotateCw className="size-3 animate-spin motion-reduce:animate-none" />
              {t("settings.updateInstalling")}
            </span>
          )}
          {update.status === "error" && (
            <>
              <span className="inline-flex h-5 items-center gap-1 rounded-full bg-err/10 px-2 text-[11px] font-medium text-err">
                <TriangleAlert className="size-3" />
                {t("settings.updateFailed")}
              </span>
              <button
                type="button"
                onClick={() => (update.version ? void window.bento?.downloadAppUpdate() : checkForUpdates())}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <RotateCw className="size-3" />
                {t("settings.updateRetry")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
