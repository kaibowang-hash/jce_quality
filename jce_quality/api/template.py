import frappe

from jce_quality.services.permissions import require_quality_execution_access
from jce_quality.services.template_baseline import create_next_template_version


@frappe.whitelist(methods=["POST"])
def create_next_quality_inspection_template_version(template_name, update_reason):
	require_quality_execution_access()
	return create_next_template_version(template_name, update_reason)
