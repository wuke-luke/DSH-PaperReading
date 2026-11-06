## 发布到 npm

包已经准备好了，`npm publish --dry-run` 通过（256 个文件，3.4 MB，包名 `dsh-paperreading`，版本 `0.6.4`）。**只差登录。**

### 需要注册吗

需要。npm 发布必须有自己的账号（免费），没有匿名发布这回事，也不支持借别人的 token 发自己的包。

1. 打开 https://www.npmjs.com/signup 注册（邮箱验证）
2. 登录后到 **Account → Two-Factor Authentication** 打开 2FA（发布时要求）
3. 回来执行：

```bash
cd D:/DESKTOP/DeepPaperReading
npm login        # 会打开浏览器，点确认即可
npm publish
```

### 不想用浏览器登录

在 npm 网站 **Access Tokens → Generate New Token → Automation** 生成一个 token，然后：

```bash
npm config set //registry.npmjs.org/:_authToken=<你的token>
npm publish
```

### 发布之后

- `dsh plugin add dsh-paperreading` 直接可用
- 插件市场的条目（PR 合并后）会自动显示版本号和下载量
- 记得在 GitHub Release 里补一句 npm 链接

### 备选：不发布也能装

`dsh plugin --profile web add https://github.com/wuke-luke/DSH-PaperReading`
或下载 Release 里的 `dsh-paperreading-0.6.4.tgz` 再 `add ./dsh-paperreading-0.6.4.tgz`。
