from zelin_pp.planning_enhancement.doctype.work_order_scheduling import work_order_scheduling

from jce_quality.services.quality import validate_quality_gate_for_scheduling


def create_stock_entry(docname, purpose):
	if purpose == "Manufacture":
		validate_quality_gate_for_scheduling(docname)
	return work_order_scheduling.create_stock_entry(docname, purpose)
