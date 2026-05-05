# JCE Quality

`jce_quality` 是一个独立的 Frappe / ERPNext 品质管理 app，用于把生产现场质量节点接入现有排产和入库流程。

首期覆盖注塑、注塑后流程和部分组装场景中的首件、巡检、末件、入库放行，并提供现场品质看板与 iPad 在线检验终端。

## 功能范围

- 独立 app：`jce_quality`，标题 `JCE Quality`。
- 主流程对接 `Work Order Scheduling`、`Scheduling Item`、`Stock Entry`、`Sample Manager`。
- 新增 `Production Quality Rule`：按公司、车间、工站、物料、物料组和质量节点匹配检验规则。
- 新增 `Production Quality Check`：承载首件、巡检、末件和入库放行的检验记录。
- 复用 ERPNext `Quality Inspection Template` 和 `Quality Inspection Reading` 管理检验项目、标准值、上下限和实际读数。
- 强制引用有效 `Sample Manager`，提交时校验样品状态、有效期、物料和模具。
- NG 检验冻结对应排产明细；让步放行仅 `Quality Manager` 可批准。
- 创建 `Manufacture` Stock Entry 前执行质量闸口；`Material Transfer` 不受影响。
- 新增 Desk Page：
  - `/app/quality-inspection-terminal`
  - `/app/quality-control-board`
- 新增 Workspace：`Quality Control`。

## 快速入口

安装并迁移后，在 Desk 中打开：

- `Quality Control` Workspace：品质配置与现场入口。
- `Production Quality Rule`：维护每个质量节点的模板、样品要求和巡检频次。
- `Production Quality Check`：查看和处理检验单、NG 处置、让步放行。
- `Quality Inspection Terminal`：iPad 在线检验终端。
- `Quality Control Board`：现场质量执行看板。

## 版本兼容

- 目标适配：ERPNext / Frappe V15 及以上。
- 本 app 依赖 `Work Order Scheduling`、`Scheduling Item`、`Sample Manager` 等现场排产对象；V15 环境安装前需确认这些对象已由对应生产排产 app 提供，并完成 `bench migrate`。
- 当前质量终端的执行权限限定为 `System Manager`、`Quality Manager`、`Quality User`；生产角色保留看板/只读入口，不再具备直接创建或提交质量检验的权限。

## 安装

```bash
cd /home/ubuntu/frappe-bench
bench --site jce.1 install-app jce_quality
bench --site jce.1 migrate
bench build --app jce_quality
bench --site jce.1 clear-cache
bench restart
```

## 文档

完整实施和使用说明见：

- [JCE Quality 品质管理 App 使用与实施指南](docs/quality_app_guide_zh.md)

## License

mit
