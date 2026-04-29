import frappe

from jce_quality.services.customizations import ensure_standard_customizations
from jce_quality.services.indexes import ensure_quality_indexes


def after_install():
	ensure_standard_customizations()
	ensure_quality_indexes()
	frappe.clear_cache()


def after_migrate():
	ensure_standard_customizations()
	ensure_quality_indexes()
	frappe.clear_cache()
