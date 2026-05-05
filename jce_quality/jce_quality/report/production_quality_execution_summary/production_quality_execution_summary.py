from __future__ import annotations

from collections import defaultdict

import frappe
from frappe import _
from frappe.utils import cint, flt, getdate, add_days, today

from jce_quality.services.quality import (
	QUALITY_NODES,
	PASSING_STATUSES,
	get_quality_requirements,
	get_scheduling_doc,
	get_scheduling_items_quality_summary,
	get_item_group_map,
	get_enabled_quality_rules,
)

FIRST_ARTICLE_FLAG_FIELDS = (
	"custom_is_first_article",
	"jce_quality_is_first_article",
	"first_article_required",
	"is_first_article",
)


def execute(filters=None):
	filters = frappe._dict(filters or {})
	columns = get_columns()
	data = get_data(filters)
	return columns, data


def get_columns():
	return [
		{"label": _("Work Order Scheduling"), "fieldname": "work_order_scheduling", "fieldtype": "Link", "options": "Work Order Scheduling", "width": 180},
		{"label": _("Work Order"), "fieldname": "work_order", "fieldtype": "Link", "options": "Work Order", "width": 160},
		{"label": _("Workstation"), "fieldname": "workstation", "fieldtype": "Link", "options": "Workstation", "width": 140},
		{"label": _("Item Code"), "fieldname": "item_code", "fieldtype": "Link", "options": "Item", "width": 160},
		{"label": _("Item Name"), "fieldname": "item_name", "fieldtype": "Data", "width": 180},
		{"label": _("Qty"), "fieldname": "qty", "fieldtype": "Float", "width": 90},
		{"label": _("Inspection Progress"), "fieldname": "inspection_progress", "fieldtype": "Small Text", "width": 300},
		{"label": _("Defect Codes"), "fieldname": "defect_codes", "fieldtype": "Small Text", "width": 220},
		{"label": _("Defect Descriptions"), "fieldname": "defect_descriptions", "fieldtype": "Text", "width": 360},
	]


def get_data(filters):
	from_date = filters.get("from_date") or add_days(today(), -7)
	to_date = filters.get("to_date") or today()
	check_filters = {
		"posting_date": ("between", [getdate(from_date), getdate(to_date)]),
		"docstatus": ("<", 2),
		"quality_node": ("in", QUALITY_NODES),
	}
	for fieldname in ("work_order_scheduling", "work_order", "workstation", "item_code"):
		if filters.get(fieldname):
			check_filters[fieldname] = filters.get(fieldname)

	checks = frappe.get_all(
		"Production Quality Check",
		filters=check_filters,
		fields=[
			"name",
			"posting_date",
			"quality_node",
			"overall_status",
			"system_overall_status",
			"docstatus",
			"work_order_scheduling",
			"scheduling_item",
			"work_order",
			"item_code",
			"item_name",
			"workstation",
			"scheduling_qty",
			"completed_qty",
			"defect_qty",
			"remarks",
			"inspection_finished_at",
			"modified",
		],
		order_by="posting_date desc, work_order_scheduling asc, workstation asc, item_code asc, modified desc",
		limit_page_length=5001,
	)
	checks_truncated = len(checks) > 5000
	if checks_truncated:
		checks = checks[:5000]
	if not checks:
		return []

	check_names = [row.name for row in checks]
	defects = frappe.get_all(
		"Production Quality Defect",
		filters={"parenttype": "Production Quality Check", "parent": ("in", check_names)},
		fields=["parent", "defect_code", "defect_name", "quantity", "remarks"],
		order_by="idx asc",
		limit_page_length=10001,
	)
	defects_truncated = len(defects) > 10000
	if defects_truncated:
		defects = defects[:10000]
	if checks_truncated or defects_truncated:
		frappe.msgprint(
			_("Report data was truncated for performance. Narrow the date range or filters to review all records."),
			indicator="orange",
		)
	defects_by_parent = defaultdict(list)
	for defect in defects:
		defects_by_parent[defect.parent].append(defect)

	groups = {}
	for check in checks:
		key = (
			check.work_order_scheduling or "",
			check.workstation or "",
			check.work_order or "",
			check.item_code or "",
		)
		group = groups.setdefault(
			key,
			{
				"work_order_scheduling": check.work_order_scheduling,
				"work_order": check.work_order,
				"workstation": check.workstation,
				"item_code": check.item_code,
				"item_name": check.item_name,
				"qty": 0,
				"checks": [],
				"defect_codes": set(),
				"defect_descriptions": [],
				"has_defect": 0,
			},
		)
		group["qty"] = max(group["qty"], flt(check.scheduling_qty) or flt(check.completed_qty) + flt(check.defect_qty))
		group["checks"].append(check)
		for defect in defects_by_parent.get(check.name, []):
			if defect.defect_code:
				group["defect_codes"].add(defect.defect_code)
		if is_bad_alert(check, defects_by_parent.get(check.name, [])):
			group["has_defect"] = 1
			message = build_defect_summary_for_report(check, defects_by_parent.get(check.name, []))
			if message:
				group["defect_descriptions"].append(
					"{0} | {1} | {2}".format(
						frappe.format(check.inspection_finished_at or check.modified, {"fieldtype": "Datetime"}),
						check.name,
						message,
					)
				)

	requirement_map = build_requirement_map(groups)
	rows = []
	for key, group in groups.items():
		rows.append(
			{
				"work_order_scheduling": group["work_order_scheduling"],
				"work_order": group["work_order"],
				"workstation": group["workstation"],
				"item_code": group["item_code"],
				"item_name": group["item_name"],
				"qty": group["qty"],
				"inspection_progress": build_progress_text(group, requirement_map.get(key) or {}),
				"defect_codes": ", ".join(sorted(group["defect_codes"])),
				"defect_descriptions": "^^^^".join(group["defect_descriptions"]),
				"has_defect": group["has_defect"],
			}
		)
	rows.sort(key=lambda row: (row.get("workstation") or "", row.get("work_order") or "", row.get("item_code") or ""))
	return rows


def build_requirement_map(groups):
	scheduling_rows = [key[0] for key in groups if key[0]]
	if not scheduling_rows:
		return {}
	fields = ["name", "parent", "work_order", "item_code", "workstation"]
	try:
		scheduling_item_meta = frappe.get_meta("Scheduling Item")
		fields.extend(
			fieldname for fieldname in FIRST_ARTICLE_FLAG_FIELDS if scheduling_item_meta.has_field(fieldname)
		)
	except Exception:
		pass

	rows = frappe.get_all(
		"Scheduling Item",
		filters={"parent": ("in", list(set(scheduling_rows)))},
		fields=fields,
		limit_page_length=5000,
	)
	if not rows:
		return {}
	item_group_map = get_item_group_map([row.item_code for row in rows])
	rules_by_node = {node: get_enabled_quality_rules(node) for node in QUALITY_NODES}
	schedule_cache = {}
	result = {}
	for row in rows:
		key = (row.parent or "", row.workstation or "", row.work_order or "", row.item_code or "")
		if key not in groups:
			continue
		if row.parent not in schedule_cache:
			schedule_cache[row.parent] = get_scheduling_doc(row.parent)
		result[key] = get_quality_requirements(
			schedule_cache[row.parent],
			row,
			item_group=item_group_map.get(row.item_code),
			rules_by_node=rules_by_node,
		)
	return result


def build_progress_text(group, requirements):
	by_node = defaultdict(list)
	for check in group["checks"]:
		by_node[check.quality_node].append(check)
	parts = []
	for node in QUALITY_NODES:
		required = cint(requirements.get(node))
		if not required:
			parts.append(_("{0}: Not Required").format(_(node)))
			continue
		checks = by_node.get(node, [])
		if node == "Patrol":
			accepted = len([row for row in checks if row.docstatus == 1 and row.overall_status in PASSING_STATUSES])
			rejected = any(row.docstatus == 1 and row.overall_status == "Rejected" for row in checks)
			status = _("Rejected") if rejected else _("{0}/{1} Completed").format(accepted, required)
			parts.append(_("{0}: {1}").format(_(node), status))
			continue
		status = get_latest_node_status(checks)
		parts.append(_("{0}: {1}").format(_(node), _(status)))
	return " | ".join(parts)


def get_latest_node_status(checks):
	if not checks:
		return "Pending"
	submitted = [row for row in checks if row.docstatus == 1]
	if any(row.overall_status == "Rejected" for row in submitted):
		return "Rejected"
	if any(row.overall_status in PASSING_STATUSES for row in submitted):
		return "Accepted"
	return "Pending"


def is_bad_alert(check, defects) -> bool:
	return (
		check.overall_status == "Rejected"
		or check.system_overall_status == "Rejected"
		or bool(defects)
	)


def build_defect_summary_for_report(check, defects) -> str:
	parts = []
	if check.quality_node:
		parts.append(_("Inspection Process") + ": " + _(check.quality_node))
	status = check.system_overall_status if check.system_overall_status == "Rejected" else check.overall_status
	if status:
		parts.append(_("Result") + ": " + _(status))
	if defects:
		parts.append(
			_("Defects", None, "JCE Quality")
			+ ": "
			+ "; ".join(
				[
					"{0}{1}{2}".format(
						row.defect_code or row.defect_name or "-",
						" x {0:g}".format(float(row.quantity)) if row.quantity else "",
						" - " + row.remarks if row.remarks else "",
					)
					for row in defects[:5]
				]
			)
		)
	if check.remarks:
		parts.append(_("Remarks") + ": " + check.remarks)
	return " | ".join(parts)
