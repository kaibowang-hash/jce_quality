import frappe

from jce_quality.services.dmr import (
	confirm_ipqc_defect,
	make_customer_exchange_stock_entry,
	make_dmr_from_source,
	make_reinspection_stock_entry,
	notify_dmr_event,
)
from jce_quality.services.permissions import require_quality_disposition_access


@frappe.whitelist(methods=["POST"])
def create_dmr_from_source(source_doctype, source_name, item_code=None, dmr_type=None):
	require_quality_disposition_access()
	return make_dmr_from_source(source_doctype, source_name, item_code=item_code, dmr_type=dmr_type)


@frappe.whitelist(methods=["POST"])
def create_customer_exchange_stock_entry(dmr_name):
	require_quality_disposition_access()
	return make_customer_exchange_stock_entry(dmr_name)


@frappe.whitelist(methods=["POST"])
def create_reinspection_stock_entry(dmr_name):
	require_quality_disposition_access()
	return make_reinspection_stock_entry(dmr_name)


@frappe.whitelist(methods=["POST"])
def confirm_ipqc_defect_api(check_name, remarks=None, create_dmr=0):
	require_quality_disposition_access()
	return confirm_ipqc_defect(check_name, remarks=remarks, create_dmr=bool(int(create_dmr)))


@frappe.whitelist(methods=["POST"])
def notify_dmr_escalation(dmr_name, level=None, extra=None):
	require_quality_disposition_access()
	return notify_dmr_event(dmr_name, "dmr_escalation", extra={"level": level, "extra": extra})


@frappe.whitelist(methods=["POST"])
def notify_dmr_return_rejection(dmr_name, extra=None):
	require_quality_disposition_access()
	return notify_dmr_event(dmr_name, "dmr_return_rejection", extra={"extra": extra})
