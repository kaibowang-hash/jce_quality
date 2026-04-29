import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


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
			"fieldname": "jce_quality_first_article_status",
			"label": "First Article Status",
			"fieldtype": "Select",
			"options": "\nPending\nAccepted\nRejected\nConcession Released",
			"insert_after": "jce_quality_section",
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
	],
}


def ensure_standard_customizations():
	create_custom_fields(STANDARD_CUSTOM_FIELDS, update=True)
	frappe.clear_cache()
