frappe.ui.form.on("Quality Inspection Method", {
	refresh(frm) {
		apply_quality_form_style(frm);
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
