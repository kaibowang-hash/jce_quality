import frappe

from jce_quality.services.customizations import ensure_standard_customizations
from jce_quality.services.indexes import ensure_quality_indexes
from jce_quality.services.permissions import ensure_quality_gate_direct_override_role
from jce_quality.services.template_baseline import migrate_quality_checklist_data
from jce_quality.services.workflows import ensure_quality_workflows


def before_migrate():
	ensure_standard_customizations(cleanup=False, include_template_version_logs=False, include_sample_tables=False)
	migrate_quality_checklist_data()


def after_install():
	ensure_standard_customizations()
	ensure_quality_indexes()
	ensure_quality_gate_direct_override_role()
	ensure_quality_workflows()
	frappe.clear_cache()


def after_migrate():
	ensure_standard_customizations()
	ensure_quality_indexes()
	ensure_quality_gate_direct_override_role()
	ensure_quality_workflows()
	frappe.clear_cache()
