# cloud

## 截屏解题助手源码

项目位于 [interview-coder-cn](interview-coder-cn)，同步自本地项目的源码、测试、构建资源和配置。

仓库保留项目源码和当前 Windows 免安装版。依赖目录、历史安装包、缓存和本地开发记录已排除。

源工程现已整合为 **2.2.2 融合版**，详见 [融合版说明](interview-coder-cn/FUSION.md)。原 `dist/win-unpacked` 保留为用户上传的 2.1.15 归档；新版本可通过源码构建，或使用本次交付的融合版 ZIP。

### Windows 免安装版

安装 Git LFS 后克隆仓库，在 [dist/win-unpacked](interview-coder-cn/dist/win-unpacked) 中运行「截屏解题助手.exe」。请保留整个目录，已有本地副本可执行「git pull」和「git lfs pull」更新。

### 本地启动

```sh
git clone https://github.com/Zachary-check/cloud.git
cd cloud/interview-coder-cn
npm ci
npm run dev
```

API 配置可在应用设置中填写，或复制项目内唯一的 [.env.example](interview-coder-cn/.env.example) 为 `.env` 后填写。

更多说明及原项目许可见 [项目 README](interview-coder-cn/README.md) 和 [LICENSE](interview-coder-cn/LICENSE)。
