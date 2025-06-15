<p align="center">
  <img src="https://raw.githubusercontent.com/gin300/RentSmartAI/main/screenshots/home.jpg" width="160" />
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/gin300/RentSmartAI/main/screenshots/chat.jpg" width="160" />
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/gin300/RentSmartAI/main/screenshots/detail.jpg" width="160" />
</p>

<h1 align="center">RentSmart AI</h1>
<p align="center"><strong>智能租房助手 · 有坑必防</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/React_Native-Expo-4630EB?style=flat&logo=expo&logoColor=white" />
  <img src="https://img.shields.io/badge/AI-DeepSeek_|_GLM--4V-1A9B5C?style=flat" />
  <img src="https://img.shields.io/badge/Map-高德地图_API-FF6A00?style=flat" />
  <img src="https://img.shields.io/badge/RAG-法律知识库-0A5C33?style=flat" />
</p>

<p align="center">
  📖 <a href="https://gin300.github.io/RentSmartAI/"><strong>查看完整产品文档 →</strong></a>
</p>

---

## 一句话介绍

把「刷平台、记条件、算通勤、怕踩坑」这些事，交给手机里的 AI 助手和你一起完成。

RentSmart AI 是一款用 AI 重构租房决策流程的移动端工具——从信息采集、智能筛选到风险预警，帮租房者把精力留给真正值得关注的那几套房。

---

## 要解决的问题

| 痛点 | 现状 |
|:---|:---|
| **信息过载** | 多平台来回切换，数百条房源靠手动翻页和记忆 |
| **决策成本高** | 价格、通勤、户型无法一次对齐，对比全靠脑记 |
| **踩坑风险** | 中介话术、合同陷阱、虚假房源，缺乏专业判断 |
| **工具割裂** | 看房、算通勤、查法律分散在不同 App |

---

## 核心功能

### 1. 多平台聚合 + AI 初筛

一次搜索覆盖 **贝壳、安居客、链家** 三大平台，DeepSeek 自动评分与简评，不用一个个 App 去翻。

### 2. 对话式 AI 找房助手

用自然语言描述需求，助手会 **先确认理解是否一致，再检索匹配房源**。采用 Function Calling Agent 架构，可自主调度查房源、算通勤、搜法律等工具。

### 3. 深度筛查与风险预警

对重点关注的房源生成深度报告。GLM-4V 多模态模型辅助看图分析，检测话术陷阱与虚假信息，还能自动生成砍价话术。

### 4. 房源对比 + 通勤计算

最多 5 套候选房横向 PK，集成 **高德地图** 实时通勤规划，价格与距离不再分开看。

### 5. RAG 法律知识库

内置租房法律语料，端侧向量检索做语义匹配，大模型基于检索结果生成回答——**有据可依，而非空口编造**。

### 6. 本地优先的数据策略

所有数据存储在本机 AsyncStorage，无需注册账号，保护隐私，打开即用。

---

## 产品界面

<table>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/gin300/RentSmartAI/main/screenshots/home.jpg" width="180"/><br/><sub>首页</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/gin300/RentSmartAI/main/screenshots/search.jpg" width="180"/><br/><sub>找房</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/gin300/RentSmartAI/main/screenshots/detail.jpg" width="180"/><br/><sub>房源详情</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/gin300/RentSmartAI/main/screenshots/chat.jpg" width="180"/><br/><sub>AI 助手</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/gin300/RentSmartAI/main/screenshots/compare.jpg" width="180"/><br/><sub>房源对比</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/gin300/RentSmartAI/main/screenshots/profile.jpg" width="180"/><br/><sub>设置</sub></td>
  </tr>
</table>

---

## 关键产品决策

> **为什么让 AI 先"对齐"再找房？**
> 用户描述需求时往往模糊，直接检索容易返回不匹配的结果。让助手先复述需求并请用户确认，减少一轮无效交互。

> **初筛 + 精筛的两层漏斗**
> 免费的 DeepSeek 做批量评分（初筛），只有用户真正感兴趣的房源才调用多模态模型深度分析（精筛）。兼顾覆盖率和成本。

> **法律知识为什么用 RAG？**
> 租房法律涉及《民法典》具体条款，大模型直接回答容易编造细节。RAG 路径先检索条文再生成回答，确保有据可依。

> **Agent 架构而非固定流程**
> 采用 Function Calling Agent，助手可自主决定调用哪个工具，让对话体验更自然灵活，也更容易扩展新能力。

---

## 技术选型

| 方向 | 技术 |
|:---|:---|
| 跨端应用 | **React Native** + **Expo**，路由 expo-router |
| 对话与工具调用 | **DeepSeek** Function Calling Agent |
| 深度视觉分析 | **智谱 GLM-4V** 多模态模型 |
| 法律知识 | **RAG**：@xenova/transformers 端侧向量化 + 语义检索 |
| 地图与通勤 | **高德地图** REST API |
| 平台抓取 | **react-native-webview** + 注入脚本 |
| 数据存储 | **AsyncStorage** 本地优先 |

---

## 使用须知

- 房源数据依赖对平台页面的扫描，受各平台展示规则影响
- AI 与地图功能需配置对应 API Key（应用内可配置）
- **所有内容仅供学习与决策参考**，不构成法律意见

---

## 免责声明

RentSmart AI 不隶属于安居客、贝壳找房或其他房产平台，为独立工具项目。请遵守各平台用户协议与当地法律法规。

<p align="center">
  <sub>Made with care · 一个产品经理的独立作品</sub>
</p>
