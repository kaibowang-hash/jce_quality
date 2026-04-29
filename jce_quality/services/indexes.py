from __future__ import annotations

import frappe


QUALITY_INDEXES = {
	"Production Quality Check": [
		("jce_qc_item_node_status", ["scheduling_item", "quality_node", "docstatus", "overall_status"]),
		("jce_qc_schedule_node_status", ["work_order_scheduling", "quality_node", "docstatus", "overall_status"]),
		("jce_qc_posting_filters", ["posting_date", "plant_floor", "shift_type", "quality_node", "docstatus"]),
	],
	"Production Quality Defect": [
		("jce_qd_parent_code", ["parent", "defect_code"]),
	],
	"Production Quality Reminder State": [
		("jce_qrs_item_node_status_due", ["scheduling_item", "quality_node", "status", "due_at"]),
	],
	"Production Quality Rule": [
		("jce_qr_node_scope", ["disabled", "quality_node", "company", "plant_floor", "workstation"]),
		("jce_qr_node_item", ["disabled", "quality_node", "item_code", "item_group"]),
	],
	"Production Quality Reminder Rule": [
		("jce_qrr_node_scope", ["disabled", "quality_node", "company", "plant_floor", "workstation", "shift_type"]),
	],
}


def ensure_quality_indexes():
	for doctype, indexes in QUALITY_INDEXES.items():
		if not frappe.db.exists("DocType", doctype):
			continue
		for index_name, fields in indexes:
			_add_index_if_possible(doctype, index_name, fields)


def _add_index_if_possible(doctype: str, index_name: str, fields: list[str]):
	table = f"tab{doctype}"
	existing_columns = {row.Field for row in frappe.db.sql(f"show columns from `{table}`", as_dict=True)}
	if any(field not in existing_columns for field in fields):
		return

	try:
		frappe.db.add_index(doctype, fields, index_name)
	except Exception:
		frappe.log_error(frappe.get_traceback(), f"Failed to add JCE Quality index {index_name}")
