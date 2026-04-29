import frappe
from frappe.model.document import Document


class ProductionQualityRule(Document):
	def validate(self):
		if self.quality_node != "Patrol":
			self.minimum_patrol_count = 0
			self.patrol_interval_mins = 0
		elif not self.minimum_patrol_count:
			self.minimum_patrol_count = 1

		if self.item_code and not self.item_group:
			self.item_group = frappe.db.get_value("Item", self.item_code, "item_group")
