from importlib import import_module

import frappe

from jce_quality.services.quality import validate_quality_gate_for_scheduling


def create_stock_entry(docname, purpose):
	if purpose == "Manufacture":
		validate_quality_gate_for_scheduling(docname, allow_direct_override=True)
	return get_work_order_scheduling_module().create_stock_entry(docname, purpose)


def get_work_order_scheduling_module():
	try:
		return import_module("zelin_pp.planning_enhancement.doctype.work_order_scheduling.work_order_scheduling")
	except ImportError as exc:
		frappe.throw(
			frappe._("zelin_pp Work Order Scheduling integration is not available on this site: {0}").format(exc)
		)
