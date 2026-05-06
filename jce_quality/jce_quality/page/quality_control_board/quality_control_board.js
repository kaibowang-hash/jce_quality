frappe.pages["quality-control-board"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Quality Control Board"),
		single_column: true,
	});
	wrapper.quality_board = new QualityControlBoard(page);
};

frappe.pages["quality-control-board"].on_page_show = function (wrapper) {
	wrapper.quality_board?.refresh();
};

class QualityControlBoard {
	constructor(page) {
		this.page = page;
		this.filters = {
			posting_date: frappe.datetime.get_today(),
			plant_floor: "",
			shift_type: "",
		};
		Object.assign(this.filters, clean_route_options(frappe.route_options || {}));
		frappe.route_options = null;
		this.setup();
	}

	setup() {
		this.page.set_primary_action(__("Refresh"), () => this.refresh(), "es-line-reload");
		this.body = $(`<div class="jce-q-board"><div class="jce-q-board-filters"></div><div class="jce-q-board-content"></div></div>`).appendTo(this.page.body);
		this.inject_style();
		this.render_filters();
	}

	render_filters() {
		const filterBar = this.body.find(".jce-q-board-filters");
		const fields = [
			{ fieldname: "posting_date", label: __("Date"), fieldtype: "Date", default: this.filters.posting_date },
			{ fieldname: "plant_floor", label: __("Plant Floor"), fieldtype: "Link", options: "Plant Floor", default: this.filters.plant_floor },
			{ fieldname: "shift_type", label: __("Shift"), fieldtype: "Select", options: get_shift_options(), default: this.filters.shift_type },
		];
		fields.forEach((df) => {
			const holder = $('<div class="jce-q-board-filter"></div>').appendTo(filterBar);
			const control = frappe.ui.form.make_control({ parent: holder, df, render_input: true });
			control.set_value(df.default || "");
			control.$input.on("change", () => {
				this.filters[df.fieldname] = control.get_value();
				this.refresh();
			});
		});
		$(`<button class="btn btn-primary">${__("Load Board")}</button>`)
			.appendTo(filterBar)
			.on("click", () => this.refresh());
	}

	refresh() {
		frappe.call({
			method: "jce_quality.api.quality.get_quality_board_data",
			args: this.filters,
			freeze: true,
			freeze_message: __("Loading quality board..."),
		}).then((r) => this.render(r.message || {}));
	}

	render(data) {
		const metrics = data.metrics || {};
		const content = this.body.find(".jce-q-board-content");
		content.empty();
		content.append(`
			<div class="jce-q-metrics">
				${metric(__("Rows"), metrics.total_rows || 0, "")}
				${metric(__("Pending First Article"), metrics.pending_first_article || 0, "warn")}
				${metric(__("Pending Patrol"), metrics.pending_patrol || 0, "warn")}
				${metric(__("Patrol Overdue"), metrics.patrol_overdue || 0, "danger")}
				${metric(__("Pending Last Article"), metrics.pending_last_article || 0, "warn")}
				${metric(__("Pending Release"), metrics.pending_release || 0, "warn")}
				${metric(__("NG Frozen"), metrics.ng_frozen || 0, "danger")}
			</div>
		`);
		content.append(`
			<div class="jce-q-section-title">${__("By Workstation")}</div>
			<div class="jce-q-workstations">
				${(data.by_workstation || []).map((row) => `
					<button class="jce-q-workstation" data-workstation="${esc(row.workstation)}">
						<b>${esc(row.workstation)}</b>
						<span>${__("Complete")}: ${row.complete || 0} / ${row.total || 0}</span>
						<span>${__("Frozen")}: ${row.frozen || 0}</span>
					</button>
				`).join("") || `<div class="jce-q-empty">${__("No workstation data.")}</div>`}
			</div>
		`);
		content.append(`
			<div class="jce-q-section-title">${__("Open Tasks", null, "JCE Quality")}</div>
			<div class="jce-q-task-table">
				${(data.tasks || []).map((task) => row_html(task)).join("") || `<div class="jce-q-empty">${__("No tasks found.")}</div>`}
			</div>
		`);
		content.find("[data-open-scheduling]").on("click", function () {
			frappe.set_route("Form", "Work Order Scheduling", this.dataset.openScheduling);
		});
	}

	inject_style() {
		if (document.getElementById("jce-quality-board-style")) return;
		$(`<style id="jce-quality-board-style">
			.jce-q-board {
				display: flex;
				flex-direction: column;
				gap: 14px;
				padding: 8px 0 20px;
			}
			.jce-q-board-filters {
				display: flex;
				gap: 10px;
				align-items: end;
				flex-wrap: wrap;
				border: 1px solid #d8dee9;
				border-radius: 16px;
				padding: 12px 14px;
				background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
			}
			.jce-q-board-filter { min-width: 180px; }
			.jce-q-board-content {
				display: flex;
				flex-direction: column;
				gap: 16px;
			}
			.jce-q-metrics {
				display: grid;
				grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
				gap: 12px;
			}
			.jce-q-metric {
				border: 1px solid #d8dee9;
				border-radius: 16px;
				padding: 14px 15px;
				background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
			}
			.jce-q-metric span {
				display: block;
				color: #64748b;
				font-size: 11px;
				font-weight: 700;
				text-transform: uppercase;
				letter-spacing: 0.04em;
				margin-bottom: 6px;
			}
			.jce-q-metric b {
				font-size: 28px;
				line-height: 1.1;
				font-weight: 700;
				color: #0f172a;
			}
			.jce-q-metric.warn b { color: #c2410c; }
			.jce-q-metric.danger b { color: #be123c; }
			.jce-q-section-title {
				font-weight: 700;
				color: #0f172a;
				margin: 2px 0 -6px;
			}
			.jce-q-workstations {
				display: grid;
				grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
				gap: 10px;
			}
			.jce-q-workstation {
				text-align: left;
				border: 1px solid #d8dee9;
				border-radius: 14px;
				background: #fff;
				padding: 12px;
				transition: border-color 0.15s ease, box-shadow 0.15s ease;
			}
			.jce-q-workstation:hover {
				border-color: #bfd3ff;
				box-shadow: 0 8px 20px rgba(15, 23, 42, 0.05);
			}
			.jce-q-workstation b, .jce-q-workstation span { display: block; }
			.jce-q-workstation b { color: #0f172a; margin-bottom: 4px; }
			.jce-q-workstation span { color: #64748b; font-size: 12px; margin-top: 3px; }
			.jce-q-task-table {
				border: 1px solid #d8dee9;
				border-radius: 16px;
				overflow: hidden;
				background: linear-gradient(180deg, #ffffff 0%, #fbfcfd 100%);
			}
			.jce-q-row {
				display: grid;
				grid-template-columns: 1.1fr 1.6fr 1fr 1fr 1fr auto;
				gap: 8px;
				align-items: center;
				padding: 11px 12px;
				border-bottom: 1px solid #eef2f7;
			}
			.jce-q-row:last-child { border-bottom: 0; }
			.jce-q-row:hover { background: #f8fafc; }
			.jce-q-muted { color: #64748b; font-size: 12px; }
			.jce-q-status-danger {
				display: inline-flex;
				border-radius: 999px;
				border: 1px solid #fecdd3;
				background: #fff1f2;
				color: #be123c;
				font-size: 11px;
				font-weight: 700;
				padding: 2px 8px;
				white-space: nowrap;
			}
			.jce-q-empty { padding: 24px; color: #64748b; text-align: center; }
			@media (max-width: 900px) {
				.jce-q-row { grid-template-columns: 1fr; }
			}
		</style>`).appendTo(document.head);
	}
}

function metric(label, value, tone) {
	return `<div class="jce-q-metric ${tone}"><span>${label}</span><b>${value}</b></div>`;
}

function row_html(task) {
	const release_status = cint(task.final_release_required) ? task.final_release_status || "Pending" : "Not Required";
	const status = task.frozen ? `<span class="jce-q-status-danger">${__("NG Frozen")}</span>` : `${esc(__(release_status))}`;
	const patrol = !cint(task.patrol_required_count)
		? "-"
		: task.patrol_overdue
			? `<span class="jce-q-status-danger">${__("Overdue", null, "JCE Quality")}</span>`
			: `${cint(task.patrol_count)} / ${cint(task.patrol_required_count)}`;
	return `
		<div class="jce-q-row">
			<div><b>${esc(task.item_code)}</b><div class="jce-q-muted">${esc(task.work_order || "-")}</div></div>
			<div>${esc(task.item_name || "")}</div>
			<div>${esc(task.workstation || "-")}</div>
			<div>${__("Patrol")}: ${patrol}</div>
			<div>${status}</div>
			<button class="btn btn-xs btn-default" data-open-scheduling="${esc(task.work_order_scheduling)}">${__("Open", null, "JCE Quality")}</button>
		</div>
	`;
}

function esc(value) {
	return frappe.utils.escape_html(String(value ?? ""));
}

function cint(value) {
	return parseInt(value || 0, 10) || 0;
}

function get_shift_options() {
	const df = frappe.meta.get_docfield("Work Order Scheduling", "shift_type");
	return df?.options || "\n白班\n晚班";
}

function clean_route_options(options) {
	const cleaned = {};
	Object.keys(options || {}).forEach((key) => {
		let value = options[key];
		if (typeof value === "string" && (value.startsWith('"') || value.startsWith("["))) {
			try {
				value = JSON.parse(value);
			} catch (e) {
				// keep raw value
			}
		}
		cleaned[key] = value;
	});
	return cleaned;
}
