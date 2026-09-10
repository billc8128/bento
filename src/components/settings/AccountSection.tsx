/**
 * 账户板块:显示名 + 头像。纯本地资料,没有账户系统;
 * 头像选图后缩到 128px 存 dataURL,不出本机。
 */

import { useEffect, useRef, useState } from "react"
import { CircleUserRound, Trash2 } from "lucide-react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useT, type TFn } from "@/lib/i18n"
import { profileInitial, setProfile, useProfile } from "@/lib/profile-store"

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
  const [version, setVersion] = useState<string>()

  useEffect(() => {
    let active = true
    void window.bento?.getAppUpdate().then((state) => {
      if (active) setVersion(state.currentVersion)
    }).catch(() => {})
    return () => { active = false }
  }, [])

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
      {version && (
        <p className="px-1 text-xs text-muted-foreground">
          Bento · {t("settings.appVersion", { version })}
        </p>
      )}
    </div>
  )
}
