frappe.ui.form.on("Work Order Scheduling", {
	refresh(frm) {
		if (frm.is_new()) return;

		render_quality_summary(frm);

		frm.add_custom_button(__("Quality Terminal"), () => {
			frappe.route_options = {
				posting_date: frm.doc.posting_date,
				plant_floor: frm.doc.plant_floor,
				shift_type: frm.doc.shift_type,
				work_order_scheduling: frm.doc.name,
			};
			frappe.set_route("quality-inspection-terminal");
		}, __("Quality"));

		frm.add_custom_button(__("Quality Board"), () => {
			frappe.route_options = {
				posting_date: frm.doc.posting_date,
				plant_floor: frm.doc.plant_floor,
				shift_type: frm.doc.shift_type,
			};
			frappe.set_route("quality-control-board");
		}, __("Quality"));

		frm.add_custom_button(__("Generate Quality Checks"), () => {
			frappe.confirm(__("Generate missing quality checks for this schedule?"), () => {
				frappe.call({
					method: "jce_quality.api.quality.generate_checks_for_scheduling",
					args: { work_order_scheduling: frm.doc.name },
					freeze: true,
					freeze_message: __("Generating quality checks..."),
				}).then((r) => {
					frappe.show_alert({
						message: __("Created {0} quality check(s).", [(r.message || []).length]),
						indicator: "green",
					});
					frm.reload_doc();
				});
			});
		}, __("Quality"));
	},
});

function render_quality_summary(frm) {
	if (!frm.fields_dict.jce_quality_summary_html) return;
	frappe.call({
		method: "jce_quality.api.quality.get_scheduling_quality_summary",
		args: { work_order_scheduling: frm.doc.name },
	}).then((r) => {
		const data = r.message || {};
		const html = `
			<div class="jce-quality-summary">
				<div><b>${__("Rows")}</b><span>${data.total || 0}</span></div>
				<div><b>${__("Complete")}</b><span class="text-success">${data.complete || 0}</span></div>
				<div><b>${__("Pending")}</b><span class="text-warning">${data.pending || 0}</span></div>
				<div><b>${__("NG Frozen")}</b><span class="text-danger">${data.frozen || 0}</span></div>
			</div>
			<style>
				.jce-quality-summary {
					display: grid;
					grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
					gap: 12px;
					margin: 10px 0 14px;
				}
				.jce-quality-summary > div {
					border: 1px solid #d8dee9;
					border-radius: 16px;
					padding: 13px 14px;
					background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
				}
				.jce-quality-summary b {
					display: block;
					font-size: 11px;
					font-weight: 700;
					text-transform: uppercase;
					letter-spacing: 0.04em;
					color: #64748b;
					margin-bottom: 6px;
				}
				.jce-quality-summary span {
					font-size: 24px;
					line-height: 1.1;
					font-weight: 700;
					color: #0f172a;
				}
			</style>
		`;
		frm.set_df_property("jce_quality_summary_html", "options", html);
	});
}
