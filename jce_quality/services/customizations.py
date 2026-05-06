import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields
from frappe.custom.doctype.property_setter.property_setter import make_property_setter


STANDARD_CUSTOM_FIELDS = {
	"Work Order Scheduling": [
		{
			"fieldname": "jce_quality_summary_section",
			"label": "Quality Summary",
			"fieldtype": "Section Break",
			"insert_after": "status",
			"collapsible": 1,
		},
		{
			"fieldname": "jce_quality_summary_html",
			"label": "Quality Summary",
			"fieldtype": "HTML",
			"insert_after": "jce_quality_summary_section",
			"read_only": 1,
		},
	],
	"Scheduling Item": [
		{
			"fieldname": "jce_quality_section",
			"label": "Quality",
			"fieldtype": "Section Break",
			"insert_after": "employee",
			"collapsible": 1,
		},
		{
			"fieldname": "custom_is_first_article",
			"label": "First Article Required",
			"fieldtype": "Check",
			"insert_after": "jce_quality_section",
			"in_list_view": 1,
		},
		{
			"fieldname": "jce_quality_first_article_status",
			"label": "First Article Status",
			"fieldtype": "Select",
			"options": "\nPending\nAccepted\nRejected\nConcession Released",
			"insert_after": "custom_is_first_article",
			"read_only": 1,
		},
		{
			"fieldname": "jce_quality_patrol_count",
			"label": "Patrol Count",
			"fieldtype": "Int",
			"insert_after": "jce_quality_first_article_status",
			"read_only": 1,
		},
		{
			"fieldname": "jce_quality_last_article_status",
			"label": "Last Article Status",
			"fieldtype": "Select",
			"options": "\nPending\nAccepted\nRejected\nConcession Released",
			"insert_after": "jce_quality_patrol_count",
			"read_only": 1,
		},
		{
			"fieldname": "jce_quality_column_break",
			"fieldtype": "Column Break",
			"insert_after": "jce_quality_last_article_status",
		},
		{
			"fieldname": "jce_quality_final_release_status",
			"label": "Final Release Status",
			"fieldtype": "Select",
			"options": "\nPending\nAccepted\nRejected\nConcession Released",
			"insert_after": "jce_quality_column_break",
			"read_only": 1,
		},
		{
			"fieldname": "jce_quality_frozen",
			"label": "Quality Frozen",
			"fieldtype": "Check",
			"insert_after": "jce_quality_final_release_status",
			"read_only": 1,
		},
		{
			"fieldname": "jce_quality_latest_check",
			"label": "Latest Quality Check",
			"fieldtype": "Link",
			"options": "Production Quality Check",
			"insert_after": "jce_quality_frozen",
			"read_only": 1,
		},
		{
			"fieldname": "jce_quality_alert_open",
			"label": "Quality Alert Open",
			"fieldtype": "Check",
			"insert_after": "jce_quality_latest_check",
			"read_only": 1,
		},
		{
			"fieldname": "jce_quality_alert_source_check",
			"label": "Quality Alert Source Check",
			"fieldtype": "Link",
			"options": "Production Quality Check",
			"insert_after": "jce_quality_alert_open",
			"read_only": 1,
		},
		{
			"fieldname": "jce_quality_alert_note",
			"label": "Quality Alert Note",
			"fieldtype": "Small Text",
			"insert_after": "jce_quality_alert_source_check",
			"read_only": 1,
		},
		{
			"fieldname": "jce_quality_extra_patrol_count",
			"label": "Extra Patrol Count",
			"fieldtype": "Int",
			"insert_after": "jce_quality_alert_note",
			"read_only": 1,
		},
		{
			"fieldname": "jce_quality_extra_patrol_source_check",
			"label": "Extra Patrol Source Check",
			"fieldtype": "Link",
			"options": "Production Quality Check",
			"insert_after": "jce_quality_extra_patrol_count",
			"read_only": 1,
		},
	],
	"Item": [
		{
			"fieldname": "custom_current_quality_inspection_template",
			"label": "Current Quality Inspection Template",
			"fieldtype": "Link",
			"options": "Quality Inspection Template",
			"insert_after": "custom_af_reference",
			"read_only": 1,
		},
	],
	"Item Quality Inspection Parameter": [
		{
			"fieldname": "inspection_method",
			"label": "Inspection Method",
			"fieldtype": "Link",
			"options": "Quality Inspection Method",
			"insert_after": "parameter_group",
			"in_list_view": 1,
		},
		{
			"fieldname": "inspection_standard",
			"label": "Inspection Standard",
			"fieldtype": "Small Text",
			"insert_after": "inspection_method",
			"in_list_view": 1,
		},
	],
	"Quality Inspection Template": [
		{
			"fieldname": "status",
			"label": "Status",
			"fieldtype": "Select",
			"options": "Draft\nPending Manufacturing Review\nPending Quality Approval\nApproved\nSuspended\nObsolete\nCancelled",
			"default": "Draft",
			"insert_after": "quality_inspection_template_name",
			"in_list_view": 1,
			"in_standard_filter": 1,
			"read_only": 1,
		},
		{
			"fieldname": "item_code",
			"label": "Item",
			"fieldtype": "Link",
			"options": "Item",
			"insert_after": "status",
			"in_list_view": 1,
			"in_standard_filter": 1,
		},
		{
			"fieldname": "item_name",
			"label": "Item Name",
			"fieldtype": "Data",
			"insert_after": "item_code",
			"read_only": 1,
		},
		{
			"fieldname": "version",
			"label": "Version",
			"fieldtype": "Data",
			"default": "A",
			"insert_after": "item_name",
			"in_list_view": 1,
			"read_only": 1,
		},
		{
			"fieldname": "naming_dd",
			"label": "YYMM",
			"fieldtype": "Data",
			"insert_after": "version",
			"in_list_view": 1,
			"read_only": 1,
		},
		{
			"fieldname": "current_effective",
			"label": "Current Effective",
			"fieldtype": "Check",
			"insert_after": "naming_dd",
			"read_only": 1,
			"in_list_view": 1,
		},
		{
			"fieldname": "af_reference",
			"label": "AF Reference",
			"fieldtype": "Link",
			"options": "Item Approval Forms",
			"insert_after": "current_effective",
			"in_list_view": 1,
			"in_standard_filter": 1,
			"read_only": 1,
		},
		{
			"fieldname": "drawing_file",
			"label": "Drawing File",
			"fieldtype": "Attach",
			"insert_after": "af_reference",
		},
		{
			"fieldname": "sample_plan",
			"label": "Inspection Sample Plan",
			"fieldtype": "Table",
			"options": "Quality Inspection Sample Plan",
			"insert_after": "item_quality_inspection_parameter",
		},
		{
			"fieldname": "template_suspension_tab",
			"label": "Suspension",
			"fieldtype": "Tab Break",
			"insert_after": "sample_plan",
		},
		{
			"fieldname": "suspended_at",
			"label": "Suspended At",
			"fieldtype": "Datetime",
			"insert_after": "template_suspension_tab",
			"read_only": 1,
		},
		{
			"fieldname": "suspended_by",
			"label": "Suspended By",
			"fieldtype": "Link",
			"options": "User",
			"insert_after": "suspended_at",
			"read_only": 1,
		},
		{
			"fieldname": "suspend_reason",
			"label": "Suspend Reason",
			"fieldtype": "Small Text",
			"insert_after": "suspended_by",
			"read_only": 1,
		},
		{
			"fieldname": "template_version_tab",
			"label": "Version Update",
			"fieldtype": "Tab Break",
			"insert_after": "suspend_reason",
		},
		{
			"fieldname": "update_source",
			"label": "Updated From Template",
			"fieldtype": "Link",
			"options": "Quality Inspection Template",
			"insert_after": "template_version_tab",
			"read_only": 1,
		},
		{
			"fieldname": "update_reason",
			"label": "Update Reason",
			"fieldtype": "Small Text",
			"insert_after": "update_source",
		},
		{
			"fieldname": "updated_from_version",
			"label": "Updated From Version",
			"fieldtype": "Data",
			"insert_after": "update_reason",
			"read_only": 1,
		},
		{
			"fieldname": "updated_to_version",
			"label": "Updated To Version",
			"fieldtype": "Data",
			"insert_after": "updated_from_version",
			"read_only": 1,
		},
		{
			"fieldname": "version_logs",
			"label": "Version Logs",
			"fieldtype": "Table",
			"options": "Quality Inspection Template Version Log",
			"insert_after": "updated_to_version",
			"read_only": 1,
		},
	],
	"Quality Inspection Reading": [
		{
			"fieldname": "inspection_method",
			"label": "Inspection Method",
			"fieldtype": "Link",
			"options": "Quality Inspection Method",
			"insert_after": "parameter_group",
			"read_only": 1,
			"in_list_view": 1,
		},
		{
			"fieldname": "inspection_standard",
			"label": "Inspection Standard",
			"fieldtype": "Small Text",
			"insert_after": "inspection_method",
			"read_only": 1,
			"in_list_view": 1,
		},
	],
	"Production Quality Check": [
		{
			"fieldname": "template_version",
			"label": "Template Version",
			"fieldtype": "Data",
			"insert_after": "quality_inspection_template",
			"read_only": 1,
		},
		{
			"fieldname": "template_af_reference",
			"label": "Template AF Reference",
			"fieldtype": "Link",
			"options": "Item Approval Forms",
			"insert_after": "template_version",
			"read_only": 1,
		},
		{
			"fieldname": "drawing_file",
			"label": "Drawing File",
			"fieldtype": "Attach",
			"insert_after": "template_af_reference",
			"read_only": 1,
		},
		{
			"fieldname": "template_warning",
			"label": "Template Warning",
			"fieldtype": "Small Text",
			"insert_after": "drawing_file",
			"read_only": 1,
		},
		{
			"fieldname": "defect_confirmation_status",
			"label": "Defect Confirmation Status",
			"fieldtype": "Select",
			"options": "\nNot Required\nPending\nConfirmed",
			"default": "Not Required",
			"insert_after": "overall_status",
			"read_only": 1,
		},
		{
			"fieldname": "system_overall_status",
			"label": "System Inspection Result",
			"fieldtype": "Select",
			"options": "\nPending\nAccepted\nRejected",
			"default": "Pending",
			"insert_after": "defect_confirmation_status",
			"read_only": 1,
		},
		{
			"fieldname": "inspection_stage",
			"label": "Inspection Stage",
			"fieldtype": "Data",
			"insert_after": "manual_inspection",
		},
		{
			"fieldname": "inspection_sample_qty",
			"label": "Inspection Sample Qty",
			"fieldtype": "Int",
			"default": "1",
			"insert_after": "inspection_stage",
			"non_negative": 1,
		},
		{
			"fieldname": "defect_sample_qty",
			"label": "Defect Sample Qty",
			"fieldtype": "Int",
			"default": "0",
			"insert_after": "inspection_sample_qty",
			"non_negative": 1,
			"read_only": 1,
		},
		{
			"fieldname": "defect_rate",
			"label": "Defect Rate (%)",
			"fieldtype": "Percent",
			"insert_after": "defect_sample_qty",
			"read_only": 1,
		},
		{
			"fieldname": "sample_readings",
			"label": "Sample Readings",
			"fieldtype": "Table",
			"options": "Production Quality Sample Reading",
			"insert_after": "readings",
		},
		{
			"fieldname": "dmr",
			"label": "DMR",
			"fieldtype": "Link",
			"options": "DMR",
			"insert_after": "system_overall_status",
			"read_only": 1,
		},
	],
	"Delivery Plan Item Qty": [
		{
			"fieldname": "jce_quality_oqc_status",
			"label": "OQC Status",
			"fieldtype": "Select",
			"options": "\nNot Started\nIn Progress\nAccepted\nRejected\nReleased\nBlocked\nTemporary Released",
			"default": "Not Started",
			"insert_after": "actual_delivered_qty",
			"read_only": 1,
			"in_list_view": 1,
			"allow_on_submit": 1,
		},
	],
	"Delivery Plan Item": [
		{
			"fieldname": "jce_quality_oqc_status",
			"label": "OQC Status",
			"fieldtype": "Select",
			"options": "\nNot Started\nIn Progress\nAccepted\nRejected\nReleased\nBlocked\nTemporary Released",
			"default": "Not Started",
			"insert_after": "actual_delivered_qty",
			"read_only": 1,
			"in_list_view": 1,
			"allow_on_submit": 1,
		},
	],
	"Stock Entry": [
		{
			"fieldname": "custom_reference_section",
			"label": "JCE Quality Reference",
			"fieldtype": "Section Break",
			"insert_after": "posting_time",
			"collapsible": 1,
		},
		{
			"fieldname": "custom_reference_doctype",
			"label": "Reference DocType",
			"fieldtype": "Data",
			"insert_after": "custom_reference_section",
			"read_only": 1,
		},
		{
			"fieldname": "custom_reference_name",
			"label": "Reference Document",
			"fieldtype": "Data",
			"insert_after": "custom_reference_doctype",
			"read_only": 1,
			"search_index": 1,
		},
		{
			"fieldname": "custom_reference_number",
			"label": "Reference Number",
			"fieldtype": "Data",
			"insert_after": "custom_reference_name",
			"read_only": 1,
			"search_index": 1,
		},
	],
}


OBSOLETE_CUSTOM_FIELDS = (
	"Item-custom_quality_checklist",
	"Production Quality Check-quality_checklist",
	"Production Quality Check-checklist_version",
	"Production Quality Check-checklist_af_reference",
	"Production Quality Check-checklist_warning",
	"Quality Inspection Template-sample_manager",
	"Quality Inspection Template-template_suspension_section",
	"Quality Inspection Template-template_version_section",
)


PROPERTY_SETTERS = (
	("Quality Inspection Template", "quality_inspection_template_name", "label", "Template No.", "Data"),
	("Quality Inspection Template", "quality_inspection_template_name", "read_only", "1", "Check"),
	("Quality Inspection Template", "quality_inspection_template_name", "reqd", "0", "Check"),
	("Quality Inspection Template", "quality_inspection_template_name", "hidden", "1", "Check"),
	("Production Quality Check", "sample_manager", "label", "Reference Sample", "Data"),
	("Production Quality Rule", "requires_sample", "label", "Require Reference Sample", "Data"),
)


def ensure_standard_customizations(
	cleanup: bool = True,
	include_template_version_logs: bool = True,
	include_sample_tables: bool = True,
):
	fields = STANDARD_CUSTOM_FIELDS
	if not include_template_version_logs or not include_sample_tables:
		fields = {
			doctype: [
				row
				for row in rows
				if not (
					doctype == "Quality Inspection Template"
					and row.get("fieldname") == "version_logs"
				)
				and not (
					not include_sample_tables
					and (
						row.get("options") == "Quality Inspection Sample Plan"
						or row.get("options") == "Production Quality Sample Reading"
						or row.get("options") == "Quality Inspection Method"
					)
				)
			]
			for doctype, rows in STANDARD_CUSTOM_FIELDS.items()
		}
	fields = {doctype: rows for doctype, rows in fields.items() if frappe.db.exists("DocType", doctype)}
	create_custom_fields(fields, update=True)
	ensure_property_setters()
	if cleanup:
		remove_obsolete_custom_fields()
	frappe.clear_cache()


def ensure_property_setters():
	for doctype, fieldname, prop, value, property_type in PROPERTY_SETTERS:
		make_property_setter(
			doctype,
			fieldname,
			prop,
			value,
			property_type,
			validate_fields_for_doctype=False,
		)


def remove_obsolete_custom_fields():
	for name in OBSOLETE_CUSTOM_FIELDS:
		if frappe.db.exists("Custom Field", name):
			frappe.delete_doc("Custom Field", name, ignore_permissions=True, force=True)
