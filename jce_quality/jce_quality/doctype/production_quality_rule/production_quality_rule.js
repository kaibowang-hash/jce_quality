frappe.ui.form.on("Production Quality Rule", {
	item_code(frm) {
		if (!frm.doc.item_code) return;
		frappe.db.get_value("Item", frm.doc.item_code, "item_group").then((r) => {
			if (r.message && r.message.item_group) {
				frm.set_value("item_group", r.message.item_group);
			}
		});
	},
});
