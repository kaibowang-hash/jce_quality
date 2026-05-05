frappe.pages["quality-analytics"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Quality Analytics"),
		single_column: true,
	});
	wrapper.quality_analytics = new QualityAnalytics(page);
};

frappe.pages["quality-analytics"].on_page_show = function (wrapper) {
	wrapper.quality_analytics?.refresh();
};

class QualityAnalytics {
	constructor(page) {
		this.page = page;
		this.filters = {
			from_date: frappe.datetime.add_days(frappe.datetime.get_today(), -30),
			to_date: frappe.datetime.get_today(),
			dimension: "workstation",
			plant_floor: "",
			shift_type: "",
			quality_node: "",
			only_ng: 0,
		};
		this.setup();
	}

	setup() {
		this.page.set_primary_action(__("Refresh"), () => this.refresh(), "refresh");
		this.body = $(`<div class="jce-q-analytics"><div class="jce-q-analytics-filters"></div><div class="jce-q-analytics-content"></div></div>`).appendTo(this.page.body);
		this.inject_style();
		this.render_filters();
	}

	render_filters() {
		const filterBar = this.body.find(".jce-q-analytics-filters");
		const fields = [
			{ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", default: this.filters.from_date },
			{ fieldname: "to_date", label: __("To Date"), fieldtype: "Date", default: this.filters.to_date },
			{ fieldname: "dimension", label: __("Dimension"), fieldtype: "Select", options: "workstation\nitem_code\nmold", default: this.filters.dimension },
			{ fieldname: "plant_floor", label: __("Plant Floor"), fieldtype: "Link", options: "Plant Floor", default: this.filters.plant_floor },
			{ fieldname: "shift_type", label: __("Shift"), fieldtype: "Select", options: get_shift_options(), default: this.filters.shift_type },
			{ fieldname: "quality_node", label: __("Quality Node"), fieldtype: "Select", options: "\nFirst Article\nPatrol\nLast Article\nFinal Release\nOQC", default: this.filters.quality_node },
			{ fieldname: "only_ng", label: __("Only NG"), fieldtype: "Check", default: this.filters.only_ng },
		];
		fields.forEach((df) => {
			const holder = $('<div class="jce-q-analytics-filter"></div>').appendTo(filterBar);
			const control = frappe.ui.form.make_control({ parent: holder, df, render_input: true });
			control.set_value(df.default || "");
			control.$input.on("change", () => {
				this.filters[df.fieldname] = control.get_value();
				this.refresh();
			});
		});
		$(`<button class="btn btn-primary">${__("Load Analytics")}</button>`)
			.appendTo(filterBar)
			.on("click", () => this.refresh());
	}

	refresh() {
		frappe.call({
			method: "jce_quality.api.quality.get_quality_analytics_data",
			args: { filters: this.filters },
			freeze: true,
			freeze_message: __("Loading quality analytics..."),
		}).then((r) => this.render(r.message || {}));
	}

	render(data) {
		const metrics = data.metrics || {};
		const content = this.body.find(".jce-q-analytics-content");
		content.empty();
		if (data.truncated?.checks || data.truncated?.defects) {
			const parts = [];
			if (data.truncated.checks) parts.push(__("inspection records"));
			if (data.truncated.defects) parts.push(__("defect records"));
			content.append(`<div class="jce-q-warning">${__("Analytics data was truncated for performance. Narrow the filters to review all {0}.", [parts.join(" / ")])}</div>`);
		}
		content.append(`
			<div class="jce-q-metrics">
				${metric(__("Production Qty"), metrics.production_qty || 0, "")}
				${metric(__("Production Defect Qty"), metrics.production_defect_qty || 0, "danger")}
				${metric(__("Production Defect Rate"), pct(metrics.production_defect_rate), "danger")}
				${metric(__("Inspection NG Rate"), pct(metrics.inspection_ng_rate), "warn")}
				${metric(__("Defect Count"), metrics.defect_count || 0, "danger")}
			</div>
		`);
		content.append(section(__("Defect Rate Trend"), trend_html(data.trend || [])));
		content.append(section(__("Dimension Ranking"), ranking_html(data.by_dimension || [])));
		content.append(section(__("Defect Code Ranking"), defect_ranking_html(data.defect_ranking || [])));
		content.append(section(__("Inspection Details"), details_html(data.details || [])));
		content.find("[data-open-check]").on("click", function () {
			frappe.set_route("Form", "Production Quality Check", this.dataset.openCheck);
		});
		content.find("[data-open-scheduling]").on("click", function () {
			frappe.set_route("Form", "Work Order Scheduling", this.dataset.openScheduling);
		});
	}

	inject_style() {
		if (document.getElementById("jce-quality-analytics-style")) return;
		$(`<style id="jce-quality-analytics-style">
			.jce-q-analytics { display: flex; flex-direction: column; gap: 14px; padding: 8px 0 20px; }
			.jce-q-analytics-filters { display: flex; gap: 10px; align-items: end; flex-wrap: wrap; border: 1px solid #d8dee9; border-radius: 16px; padding: 12px 14px; background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%); }
			.jce-q-analytics-filter { min-width: 160px; }
			.jce-q-analytics-content { display: flex; flex-direction: column; gap: 16px; }
			.jce-q-warning { border: 1px solid #fed7aa; background: #fff7ed; color: #9a3412; border-radius: 8px; padding: 10px 12px; font-size: 13px; font-weight: 600; }
			.jce-q-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
			.jce-q-metric { border: 1px solid #d8dee9; border-radius: 16px; padding: 14px 15px; background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%); }
			.jce-q-metric span { display: block; color: #64748b; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
			.jce-q-metric b { font-size: 28px; line-height: 1.1; font-weight: 700; color: #0f172a; }
			.jce-q-metric.warn b { color: #c2410c; }
			.jce-q-metric.danger b { color: #be123c; }
			.jce-q-panel { border: 1px solid #d8dee9; border-radius: 18px; background: #fff; padding: 14px; }
			.jce-q-panel h3 { margin: 0 0 10px; font-size: 16px; color: #0f172a; }
			.jce-q-bars { display: grid; gap: 8px; }
			.jce-q-bar-row { display: grid; grid-template-columns: minmax(90px, 140px) 1fr minmax(70px, auto); gap: 8px; align-items: center; font-size: 12px; }
			.jce-q-bar-track { height: 10px; border-radius: 999px; background: #f1f5f9; overflow: hidden; }
			.jce-q-bar-fill { height: 100%; border-radius: 999px; background: #be123c; min-width: 2px; }
			.jce-q-table-shell { overflow: auto; border: 1px solid #eef2f7; border-radius: 14px; }
			.jce-q-table { width: 100%; margin: 0; font-size: 12px; }
			.jce-q-table th { background: #f8fafc; color: #334155; font-weight: 700; position: sticky; top: 0; }
			.jce-q-table td, .jce-q-table th { padding: 9px 10px; border-bottom: 1px solid #eef2f7; }
			.jce-q-table tr:last-child td { border-bottom: 0; }
			.jce-q-table tr:hover td { background: #f8fafc; }
			.jce-q-empty { padding: 24px; color: #64748b; text-align: center; }
			.jce-q-status-danger { display: inline-flex; border-radius: 999px; border: 1px solid #fecdd3; background: #fff1f2; color: #be123c; font-size: 11px; font-weight: 700; padding: 2px 8px; white-space: nowrap; }
			@media (max-width: 900px) {
				.jce-q-bar-row { grid-template-columns: 1fr; }
			}
		</style>`).appendTo(document.head);
	}
}

function section(title, html) {
	return `<section class="jce-q-panel"><h3>${esc(title)}</h3>${html}</section>`;
}

function metric(label, value, tone) {
	return `<div class="jce-q-metric ${tone}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
}

function trend_html(rows) {
	if (!rows.length) return `<div class="jce-q-empty">${__("No analytics data.")}</div>`;
	const max = Math.max(...rows.map((row) => row.production_defect_rate || 0), 0.01);
	return `<div class="jce-q-bars">${rows.map((row) => bar(row.date, pct(row.production_defect_rate), (row.production_defect_rate || 0) / max)).join("")}</div>`;
}

function ranking_html(rows) {
	if (!rows.length) return `<div class="jce-q-empty">${__("No ranking data.")}</div>`;
	const max = Math.max(...rows.map((row) => row.defect_count || row.rejected_checks || 0), 1);
	return `<div class="jce-q-bars">${rows.map((row) => bar(row.dimension, `${pct(row.production_defect_rate)} / ${row.defect_count || 0}`, (row.defect_count || row.rejected_checks || 0) / max)).join("")}</div>`;
}

function defect_ranking_html(rows) {
	if (!rows.length) return `<div class="jce-q-empty">${__("No defect data.")}</div>`;
	const max = Math.max(...rows.map((row) => row.quantity || 0), 1);
	return `<div class="jce-q-bars">${rows.map((row) => bar(`${row.defect_code || "-"} ${row.defect_name || ""}`, row.quantity || 0, (row.quantity || 0) / max)).join("")}</div>`;
}

function bar(label, value, ratio) {
	return `
		<div class="jce-q-bar-row">
			<div>${esc(label || "-")}</div>
			<div class="jce-q-bar-track"><div class="jce-q-bar-fill" style="width:${Math.max(2, Math.min(100, ratio * 100))}%"></div></div>
			<b>${esc(value)}</b>
		</div>
	`;
}

function details_html(rows) {
	if (!rows.length) return `<div class="jce-q-empty">${__("No inspection details.")}</div>`;
	return `
		<div class="jce-q-table-shell">
			<table class="table jce-q-table">
				<thead>
					<tr>
						<th>${__("Date")}</th>
						<th>${__("Inspection")}</th>
						<th>${__("Item")}</th>
						<th>${__("Workstation")}</th>
						<th>${__("Result", null, "JCE Quality")}</th>
						<th>${__("Defects", null, "JCE Quality")}</th>
						<th>${__("Rate", null, "JCE Quality")}</th>
						<th>${__("Actions")}</th>
					</tr>
				</thead>
				<tbody>
					${rows.map((row) => `
						<tr>
							<td>${esc(row.posting_date || "")}</td>
							<td>${esc(row.name)}<div class="text-muted">${esc(row.quality_node || "")}</div></td>
							<td>${esc(row.item_code || "")}<div class="text-muted">${esc(row.item_name || "")}</div></td>
							<td>${esc(row.workstation || "-")}</td>
							<td>${row.overall_status === "Rejected" ? `<span class="jce-q-status-danger">${__("Rejected")}</span>` : esc(__(row.overall_status || ""))}</td>
							<td>${esc(row.defect_codes || "-")}<div class="text-muted">${esc(row.defect_total || 0)}</div></td>
							<td>${pct(row.production_defect_rate)}</td>
							<td>
								<button class="btn btn-xs btn-default" data-open-check="${esc(row.name)}">${__("Check", null, "JCE Quality")}</button>
								${row.work_order_scheduling ? `<button class="btn btn-xs btn-default" data-open-scheduling="${esc(row.work_order_scheduling)}">${__("Schedule", null, "JCE Quality")}</button>` : ""}
							</td>
						</tr>
					`).join("")}
				</tbody>
			</table>
		</div>
	`;
}

function pct(value) {
	return `${((value || 0) * 100).toFixed(2)}%`;
}

function esc(value) {
	return frappe.utils.escape_html(String(value ?? ""));
}

function get_shift_options() {
	const df = frappe.meta.get_docfield("Work Order Scheduling", "shift_type");
	return df?.options || "\n白班\n晚班";
}
