附件信息：
0）整体大概有点像 Codex 或者 Claude Cowork 或者 Workbuddy 的界面，早期可以 Mobile First，先考虑移动用户的体验；
1）里面有两位 KOL，https://www.themarketbrew.com/kol/qinbafrank，https://www.themarketbrew.com/kol/aleabitoreddit，他俩的推是https://x.com/qinbafrank，https://x.com/aleabitoreddit，记得取一下他们的头像；
2）白毛股神的历史推文和X Articles，https://github.com/yan-labs/serenity-aleabitoreddit 在这里有；qinbafrank 的我暂时没找到，可能需要爬，你也可以自己找一下；
3）需要考虑 Twitter 内容的更新，所以所有的博主数据你抓下来之后都要存到 CF 里，然后每天 CF 在后台跑数据更新一次；
4）TwitterAPI 是收费的且挺贵的，所以你在取的时候要注意只取增量数据（注意别取漏了），每天更新一次，把所有的 TWITTER 的数据都存在自己的数据库里（要有各种信息比如原文、时间、引用等等），你要把你爬下来的所有推特原文完整存起来，爬下来这些数据不容易都是收费的
5）Twitter API 先用这个，我充了 10 美元，请在调用的时候检查确实返回的是你想要的数据再获取，否则很快就用完了：<GETXAPI_KEY 已脱敏，存于本地 account.guard.json / Worker secret GETXAPI_KEY>，npx -y @getxapi/mcp@latest，https://www.getxapi.com/
6）AI 的 GATEWAY 也写到了 json 里，一开始我们就支持两个模型，让用户自己选择使用什么模型来回答：deepseek/deepseek-v4-flash 和 deepseek/deepseek-v4-pro。此外还需要考虑成本问题，缓存命中则便宜，所以在构造 prompt 的时候要把固定不变的放在最前面，比如 KOL 的人设逻辑记忆之类。
7）之后还得选择支持更多 KOL，你需要考虑每个 KOL 的记忆不能串台，也得考虑多轮对话后 AI 忘记自己的知识和人设的风险，让 AI 能够保持长期记忆稳定和语气稳定，所以：每个 KOL 独立 Persona Pack
固定保存身份、方法论、语气、禁区、回答格式；每轮都注入，不能靠模型自己记。Persona 不要因为一条新推文就自动修改，建议每周系统自动更新一次。知识层：所有数据强制带 kol_id
推文、文章、观点和向量索引都必须明确属于哪个 KOL，不能让模型自己决定“应该去哪个人物库搜索”，否则很容易把不同 KOL 的观点混在一起。会话层：一个线程固定绑定一个 KOL多轮记忆：不要无限堆聊天记录。
8）“蒸馏”一个KOL，除了我希望复刻的“https://www.themarketbrew.com/kol”，目前也有一些开源项目也能借鉴思路，可以直接看一下：https://github.com/muxuuu/serenity-skill 是把它的推蒸馏成了方法；https://github.com/alchaincyf/nuwa-skill 是对任意一个 KOL 的蒸馏通用工具；https://github.com/codeman008/awesome-distillhub-persona-skills 同样也是一个蒸馏器。这里我们都绝对不采用微调模型的方式，而是采用调用 API + 外挂的方式，这样能享受模型升级之后带来的红利。
9）如果你要画价格曲线和 K 线，请直接用这个：https://benji.org/liveline
10）用户在问问题的时候经常会问某个 KOL 如“你怎么看 CRCL 现在该不该买”，这个时候你首先需要知道 CRCL 是一个股票，还是个美股，然后还知道它现在的价格、基本面等各种信息。现在的信息怎么拿呢？https://github.com/simonlin1212/global-stock-data 这个是美港股数据包，https://github.com/simonlin1212/a-stock-data 这个是 A 股数据包，westock-data 和 westock-tool 是腾讯自选股的 skill，还有 富途 OpenAPI 交易与行情助手 宏观数据监控技能 腾讯自选股行情数据接口 自然语言通用金融数据搜索服务，通过这些 skill 都可以取出来，优先选后面几个我已经放到目录中的。

curl https://gateway.ai.cloudflare.com/v1/686bee522c90d03e13ba35077f04ff49/robin/openai/chat/completions \
  -H 'cf-aig-authorization: Bearer $CF_AIG_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hello"}]}'



