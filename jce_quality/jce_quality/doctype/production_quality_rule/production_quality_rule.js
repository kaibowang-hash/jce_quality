frappe.ui.form.on("Production Quality Rule", {
	refresh(frm) {
		apply_quality_form_style(frm);
	},

	item_code(frm) {
		if (!frm.doc.item_code) return;
		frappe.db.get_value("Item", frm.doc.item_code, "item_group").then((r) => {
			if (r.message && r.message.item_group) {
				frm.set_value("item_group", r.message.item_group);
			}
		});
	},

	validate(frm) {
		apply_quality_form_style(frm);
	},
});

function apply_quality_form_style(frm) {
	frappe.require("/assets/jce_quality/js/quality_form_style.js", () => {
		window.jce_quality?.form_style?.apply(frm);
	});
}
