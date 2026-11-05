# 来源记录与第三方许可

2.0 前端使用 assistant-ui、React、react-markdown、remark/rehype 和 KaTeX 等依赖。版本由 package-lock.json 固定，构建中实际使用的包及许可文本保存在 dist/THIRD-PARTY-LICENSES.txt，组件构建记录位于 dist/build-info.json。该依赖集成不重新引入原 AI4Typora 的业务源码。

本项目由 AI4Typora 的本地定制版本整理而来。原插件业务模块和资源已移出当前项目；Typora 宿主适配层重新实现，DeepSeek 问答、布局和窗口模块继续维护。此记录保留开发来源，不声称是无任何历史关联的全新作品。

历史来源：KokuYu-sysu/typora-gpt-edit（AI4Typora），本地基线提交 58107f3e91e463b50557aa5f1ca2c13324323a66。

运行时仍依赖通用的 typora-community-plugin 框架。框架独立安装，不包含在本项目源码中，其许可由框架自身保留。

为保留历史来源的完整许可说明，附原项目 MIT 许可：

```text
MIT License

Copyright (c) 2026 Jiahao Lin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```
