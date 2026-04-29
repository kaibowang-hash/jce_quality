# JCE Quality 品质管理 App 使用与实施指南

版本日期：2026-04-28

## 1. 目标

`jce_quality` 用于把生产现场的关键质量节点上系统，让品质动作和排产、样品、入库流程形成闭环。

首期目标：

- 质量流程不混入其它 app，保持 `jce_quality` 独立维护。
- 以 `Work Order Scheduling` 作为现场批次和班次入口。
- 在首件、巡检、末件、入库放行四个节点创建检验记录。
- 检验标准继续使用 ERPNext 标准的 `Quality Inspection Template`。
- 检验时必须引用有效的 `Sample Manager`。
- NG 后冻结对应排产明细，处理完成或质量经理让步放行后才允许继续入库。
- 提供现场品质看板和 iPad 网页检验终端。

## 2. 适用业务

适合以下场景：

- 注塑生产：首件确认、定时巡检、末件确认、入库放行。
- 注塑后流程：喷涂、丝印、组装前后质量确认。
- 部分组装：按工站、班次、物料建立检验任务。
- 有标准样品或限度样品管理要求的生产现场。

首期不包含：

- 离线 PWA。
- 扫码免登录。
- 自动缺陷 Pareto 分析。
- 和 `light_mes` 的强依赖。

## 3. 核心对象

### 3.1 Production Quality Rule

用于定义某个质量节点应该如何检验。

关键字段：

- `Quality Node`：质量节点，支持 `First Article`、`Patrol`、`Last Article`、`Final Release`。
- `Mandatory Gate`：是否作为强制闸口。
- `Company`：公司范围。
- `Plant Floor`：车间范围。
- `Workstation`：工站范围。
- `Item Code`：指定物料。
- `Item Group`：指定物料组。
- `Quality Inspection Template`：检验模板。
- `Require Sample Manager Reference`：是否必须引用样品。
- `Required Sample Type`：强制样品类型。
- `Minimum Patrol Count`：巡检最低次数，仅对 `Patrol` 生效。
- `Patrol Interval (Minutes)`：巡检间隔分钟数，用于看板显示巡检逾期。

规则优先级：

1. `Item Code` 优先于 `Item Group`。
2. 工站规则优先于车间规则。
3. 更具体的规则优先于默认规则。
4. 没有匹配规则时，系统默认四个节点都是必检，巡检至少 1 次。

建议配置方式：

1. 先按公司和车间配置一组默认规则。
2. 对关键工站或特殊物料单独配置覆盖规则。
3. 对塑胶件、外观件、装配件分别设置合适的样品类型。
4. 对巡检节点设置 `Minimum Patrol Count` 和 `Patrol Interval (Minutes)`。

### 3.2 Production Quality Check

现场实际检验单。

来源信息：

- `Work Order Scheduling`
- `Scheduling Item Row`
- `Work Order`
- `Item Code`
- `Item Group`
- `Plant Floor`
- `Workstation`
- `Shift Type`
- `Mold`
- `Scheduling Qty`
- `Completed Qty`
- `Defect Qty`

检验信息：

- `Quality Node`
- `Quality Inspection Template`
- `Readings`
- `Sample Manager`
- `Inspection Result`
- `Inspection Photo`
- `Remarks`

NG 处置信息：

- `Disposition`：`Rework`、`Scrap`、`Concession Release`。
- `Disposition Remarks`
- `Disposition By`
- `Disposition At`
- `Concession Release Approved`
- `Approved By`
- `Approved At`

## 4. 样品强校验

提交 `Production Quality Check` 时，如果规则要求样品，系统会校验：

- 必须填写 `Sample Manager`。
- `Sample Manager` DocType 必须存在。
- 样品 `status` 必须为 `Active`。
- 样品不能过期，校验字段为 `exp_date`。
- 样品 `against_item` 必须等于检验单 `item_code`。
- 检验单有 `mold` 且样品也有 `mold` 时，两者必须一致。
- 规则指定 `Required Sample Type` 时，样品 `sample_type` 必须一致。

样品校验失败时，检验单不能提交通过。

## 5. 读数判定

系统复用 ERPNext 标准子表 `Quality Inspection Reading`。

支持三类判定：

- 数值型：检查 `reading_1` 到 `reading_10` 是否在 `min_value` 和 `max_value` 范围内。
- 值匹配：检查 `reading_value` 是否等于模板配置的 `value`。
- 公式型：执行模板中的 `acceptance_formula`，可使用 `reading_1` 到 `reading_10` 和 `mean`。

提交时要求：

- 非手工结果时，必须有模板读数。
- 数值型读数至少填写一个实际读数。
- 值匹配读数必须填写 `reading_value`。
- 任一读数不合格，整张检验单为 `Rejected`。
- 勾选 `Manual Result` 时，以单据的 `Inspection Result` 为准。

## 6. 生产流程

### 6.1 生成质量检查单

入口：

- 打开 `Work Order Scheduling`。
- 点击 `Quality` 分组下的 `Generate Quality Checks`。

系统动作：

- 遍历排产单中的 `Scheduling Item`。
- 按规则为缺失的节点生成 `Production Quality Check`。
- 对巡检节点按 `Minimum Patrol Count` 补足数量。
- 已存在未取消检验单时不会重复生成。

### 6.2 iPad 现场检验

入口：

- Desk Page：`/app/quality-inspection-terminal`
- 也可以从 `Work Order Scheduling` 按钮 `Quality Terminal` 进入。

使用方式：

1. 质检员登录 ERPNext。
2. 用 iPad Safari 或 Chrome 打开终端页面。
3. 按日期、车间、班次加载今日任务。
4. 点击首件、巡检、末件或放行节点。
5. 输入 `Sample Manager`。
6. 按检验项目录入实际读数。
7. 可上传现场照片。
8. 点击 `Submit Inspection` 提交。
9. 如现场直接判 NG，可点击 `Mark NG`。
10. 已提交 NG 后，可点击 `Apply Concession Release` 发起让步放行处置。

页面显示：

- 物料和物料名称。
- 工单。
- 排产数量。
- 工站。
- 班次。
- 样品要求。
- 检验项目。
- 标准值、上下限。
- 实际读数。
- NG 冻结状态。
- 巡检逾期状态。

### 6.3 NG 冻结

当某个 `Scheduling Item` 存在已提交的 `Rejected` 检验单时：

- 对应排产明细视为质量冻结。
- 品质看板显示 `NG Frozen`。
- iPad 终端任务显示 `NG Frozen`。
- 创建 `Manufacture` Stock Entry 时会被阻止。

### 6.4 NG 处置

支持三种处置：

- `Rework`：返工。
- `Scrap`：报废。
- `Concession Release`：让步放行。

让步放行流程：

1. 检验单为 `Rejected`。
2. 设置 `Disposition` 为 `Concession Release`。
3. 具备 `Quality Manager` 角色的用户点击 `Approve Concession Release`。
4. 系统将检验结果更新为 `Concession Released`。
5. 对应排产明细质量冻结解除。
6. 入库闸口允许继续判断其它质量节点。

## 7. 入库闸口

系统在两个位置阻止未放行入库：

- 覆盖 `Work Order Scheduling` 的 `create_stock_entry` 白名单方法。
- 在 `Stock Entry.before_submit` 中再次校验。

校验范围：

- 仅对 `Stock Entry.purpose == Manufacture` 生效。
- `Material Transfer` 不受质量闸口影响。
- 有完工数量或不良数量的排产明细需要通过质量闸口。

每个相关排产明细必须满足：

- 首件有至少 1 张通过或让步放行的检验单。
- 巡检达到规则要求次数，默认至少 1 次。
- 末件有至少 1 张通过或让步放行的检验单。
- 入库放行有至少 1 张通过或让步放行的检验单。
- 不存在仍为 `Rejected` 的阻塞检验单。

## 8. 品质看板

入口：

- Desk Page：`/app/quality-control-board`
- Workspace：`Quality Control`
- `Work Order Scheduling` 按钮 `Quality Board`

首期指标：

- `Rows`：排产明细数量。
- `Pending First Article`：待首件数量。
- `Pending Patrol`：未完成巡检数量。
- `Patrol Overdue`：按巡检间隔判断的巡检逾期数量。
- `Pending Last Article`：待末件数量。
- `Pending Release`：待入库放行数量。
- `NG Frozen`：NG 冻结数量。

维度：

- 按工站统计总数、完成数、冻结数。
- 任务列表可打开对应 `Work Order Scheduling`。

## 9. Work Order Scheduling 扩展

安装 app 后，系统会在 `Work Order Scheduling` 上增加：

- `Quality Summary` 区块。
- `Quality Terminal` 按钮。
- `Quality Board` 按钮。
- `Generate Quality Checks` 按钮。

系统会在 `Scheduling Item` 上增加：

- `First Article Status`
- `Patrol Count`
- `Last Article Status`
- `Final Release Status`
- `Quality Frozen`
- `Latest Quality Check`

这些字段由系统同步维护，用户不需要手工修改。

## 10. 权限建议

建议角色分工：

- `Quality Manager`：维护规则、提交和取消检验、审批让步放行。
- `Manufacturing Manager`：查看检验、看板和排产质量状态。
- `Manufacturing User`：查看现场质量任务和检验状态。
- `System Manager`：系统配置和故障处理。

如果质检员需要直接在 iPad 上提交检验单，需要给对应角色补充 `Production Quality Check` 的创建、写入、提交权限。

## 11. 实施步骤

1. 确认 `jce_quality` 已安装并迁移。
2. 确认 `Sample Manager` 已启用，并维护有效样品。
3. 维护 `Quality Inspection Parameter`。
4. 维护 `Quality Inspection Template`。
5. 按车间、工站、物料或物料组维护 `Production Quality Rule`。
6. 创建或选择一张 `Work Order Scheduling`。
7. 点击 `Generate Quality Checks`。
8. 使用 iPad 终端完成首件、巡检、末件、放行检验。
9. 在品质看板确认待办和异常。
10. 创建 `Manufacture` Stock Entry 验证闸口。

## 12. 验收测试

### 12.1 规则匹配

测试目标：

- 物料规则优先于物料组规则。
- 工站规则优先于车间规则。
- 默认规则在没有更具体规则时生效。

建议步骤：

1. 建一个按物料组的巡检规则。
2. 建一个同节点、同物料组、指定物料的巡检规则。
3. 生成检验单。
4. 检查检验单引用的 `Production Quality Rule` 是否为物料规则。

### 12.2 样品强校验

应验证以下情况不能提交通过：

- 未填写 `Sample Manager`。
- 样品状态不是 `Active`。
- 样品已过期。
- 样品 `against_item` 与检验物料不一致。
- 检验单有模具且样品模具不一致。
- 规则要求的样品类型不一致。

### 12.3 节点闸口

应验证以下情况不能创建 `Manufacture` 入库单：

- 缺首件。
- 巡检次数不足。
- 缺末件。
- 缺入库放行。
- 存在未处置或未让步批准的 NG。

### 12.4 NG 冻结

建议步骤：

1. 提交一张 `Rejected` 检验单。
2. 查看 `Scheduling Item.Quality Frozen` 是否勾选。
3. 尝试创建 `Manufacture` Stock Entry，应被阻止。
4. 设置处置为 `Concession Release`。
5. 使用 `Quality Manager` 审批。
6. 再次尝试入库，应进入其它节点校验。

### 12.5 iPad 页面

建议在 iPad 尺寸下验证：

- 今日任务列表加载。
- 长物料名称和长标准文本不溢出。
- 首件、巡检、末件、放行按钮可点击。
- 读数可录入。
- 草稿可保存。
- 检验可提交。
- 照片可上传。
- NG 可标记。
- 让步放行申请可提交。

### 12.6 回归

应确认以下标准流程不受破坏：

- 标准 `Quality Inspection`。
- `Sample Manager` 日常维护。
- `Material Transfer` Stock Entry。
- 普通排产单查看和保存。

## 13. 运维命令

安装：

```bash
bench --site jce.1 install-app jce_quality
```

迁移：

```bash
bench --site jce.1 migrate
```

构建前端资源：

```bash
bench build --app jce_quality
```

清缓存：

```bash
bench --site jce.1 clear-cache
```

重启：

```bash
bench restart
```

验证 app 是否安装：

```bash
bench --site jce.1 list-apps
```

验证看板 API：

```bash
bench --site jce.1 execute jce_quality.api.quality.get_quality_board_data --kwargs "{'posting_date':'2026-04-28'}"
```

## 14. 常见问题

### 14.1 生成不了检验单

检查：

- `Work Order Scheduling` 是否有 `Scheduling Item`。
- `Scheduling Item` 是否有物料、工站和工单。
- `Production Quality Rule` 是否被禁用。
- 目标节点是否为必检。
- 是否已经存在未取消的同节点检验单。

### 14.2 检验单没有读数

检查：

- 规则是否配置了 `Quality Inspection Template`。
- 物料是否配置了默认 `quality_inspection_template`。
- 模板下是否有 `Item Quality Inspection Parameter`。
- 检验单是否已提交，已提交单据不能重新加载模板。

### 14.3 样品校验失败

检查：

- `Sample Manager.status` 是否为 `Active`。
- `exp_date` 是否过期。
- `against_item` 是否等于检验物料。
- `mold` 是否匹配。
- `sample_type` 是否符合规则要求。

### 14.4 入库被阻止

打开错误提示中的排产行和质量节点，检查：

- 该节点是否缺少已提交且通过的检验单。
- 巡检通过次数是否低于规则要求。
- 是否存在 `Rejected` 检验单。
- 让步放行是否已由 `Quality Manager` 审批。

### 14.5 iPad 页面没有任务

检查：

- 筛选日期是否等于排产日期。
- 车间和班次筛选是否过窄。
- 当前用户是否有读取 `Work Order Scheduling`、`Scheduling Item` 和 `Production Quality Check` 的权限。
- 当天是否确实有排产明细。

## 15. 后续扩展建议

可在后续版本加入：

- 缺陷代码和缺陷图片多附件。
- 模具、物料、工站维度的不良率趋势。
- 缺陷排行和 Pareto 分析。
- 巡检自动任务提醒。
- 二维码打开指定排产行。
- 离线 PWA。
- 更细的让步放行审批流。
- 和 MES 设备数据或扫码报工联动。
