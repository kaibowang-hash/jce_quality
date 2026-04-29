from frappe.model.document import Document
from frappe.utils import cint


class ProductionQualityReminderRule(Document):
	def validate(self):
		self.quality_node = self.quality_node or "Patrol"
		if not cint(self.repeat_interval_mins):
			self.repeat_interval_mins = 30
