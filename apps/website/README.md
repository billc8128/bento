# Bento website

Bento 官网的静态页面源码。

- `index.html`：页面、样式和交互。
- `assets/`：图片、视频和图标。
- `wrangler.jsonc`：静态资源预览配置。

在仓库根目录运行：

```sh
pnpm install
pnpm dev:website
```

访问 `http://127.0.0.1:3082`。页面直接使用静态源码，无需构建。

设计变体位于 `promo/website-variants`。
