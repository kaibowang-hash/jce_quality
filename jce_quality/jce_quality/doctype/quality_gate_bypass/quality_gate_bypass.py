import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, now_datetime


class QualityGateBypass(Document):
	def before_insert(self):
		self.populate_reference_details()
		self.requested_by = self.requested_by or frappe.session.user
		self.requested_role = self.requested_role or get_trace_role(("Stock User", "Manufacturing Manager", "Quality Manager", "System Manager"))
		self.requested_at = self.requested_at or now_datetime()

	def validate(self):
		self.populate_reference_details()
		self.populate_item_details()
		if self.status == "Approved":
			self.validate_bypass_scope()
			self.validate_approval_authority()
			self.approved_by = self.approved_by or frappe.session.user
			self.approved_role = self.approved_role or get_trace_role(("Quality Manager", "System Manager"))
			self.approved_at = self.approved_at or now_datetime()

	def populate_reference_details(self):
		if self.work_order_scheduling and not (self.reference_doctype and self.reference_name):
			self.reference_doctype = "Work Order Scheduling"
			self.reference_name = self.work_order_scheduling
		if not (self.reference_doctype and self.reference_name and frappe.db.exists(self.reference_doctype, self.reference_name)):
			return
		if self.reference_doctype == "Stock Entry":
			stock_entry = frappe.get_doc("Stock Entry", self.reference_name)
			self.company = self.company or stock_entry.company
			first_item = (stock_entry.get("items") or [None])[0]
			if first_item:
				self.item_code = self.item_code or first_item.item_code
				self.qty = self.qty or first_item.qty
				self.uom = self.uom or first_item.uom
				self.source_warehouse = self.source_warehouse or first_item.s_warehouse
				self.target_warehouse = self.target_warehouse or first_item.t_warehouse
				self.warehouse = self.warehouse or first_item.t_warehouse or first_item.s_warehouse
		elif self.reference_doctype == "Work Order Scheduling":
			scheduling = frappe.get_doc("Work Order Scheduling", self.reference_name)
			self.company = self.company or scheduling.get("company")
			items = list(scheduling.get("scheduling_items") or [])
			first_item = items[0] if len(items) == 1 else None
			if first_item:
				self.scheduling_item = self.scheduling_item or first_item.name
				self.item_code = self.item_code or first_item.item_code
				self.qty = self.qty or first_item.get("completed_qty") or first_item.get("scheduling_qty")

	def populate_item_details(self):
		if not self.item_code:
			return
		item = frappe.db.get_value("Item", self.item_code, ["item_name", "stock_uom"], as_dict=True)
		if item:
			self.item_name = item.item_name
			self.uom = self.uom or item.stock_uom

	def validate_approval_authority(self):
		if frappe.session.user == "Administrator":
			return
		roles = set(frappe.get_roles())
		if roles.intersection({"System Manager", "Quality Manager"}):
			return
		frappe.throw(_("Only Quality Manager can approve quality gate bypass."), frappe.PermissionError)

	def validate_bypass_scope(self):
		if self.reference_doctype == "Stock Entry" and self.reference_name:
			return
		references_schedule = self.work_order_scheduling or (
			self.reference_doctype == "Work Order Scheduling" and self.reference_name
		)
		if not references_schedule:
			frappe.throw(_("Quality gate bypass must reference a Stock Entry or Work Order Scheduling."))
		if self.scheduling_item:
			if not frappe.db.exists("Scheduling Item", self.scheduling_item):
				frappe.throw(_("Scheduling Item {0} does not exist.").format(self.scheduling_item))
			schedule_name = self.work_order_scheduling
			if not schedule_name and self.reference_doctype == "Work Order Scheduling":
				schedule_name = self.reference_name
			if schedule_name:
				parent = frappe.db.get_value("Scheduling Item", self.scheduling_item, "parent")
				if parent and parent != schedule_name:
					frappe.throw(_("Scheduling Item does not belong to the selected Work Order Scheduling."))
			return
		if self.item_code and flt(self.qty) > 0:
			return
		frappe.throw(_("Work Order Scheduling bypass must specify a Scheduling Item or Item with positive Qty."))


def get_trace_role(preferred_roles: tuple[str, ...]) -> str | None:
	if frappe.session.user == "Administrator":
		return "System Manager"
	user_roles = set(frappe.get_roles())
	for role in preferred_roles:
		if role in user_roles:
			return role
	return next(iter(user_roles), None)
