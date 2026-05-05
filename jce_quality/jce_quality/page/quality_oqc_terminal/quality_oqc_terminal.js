frappe.pages["quality-oqc-terminal"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("OQC Shipping Inspection"),
		single_column: true,
	});
	wrapper.quality_oqc_terminal = new QualityOQCTerminal(page);
};

frappe.pages["quality-oqc-terminal"].on_page_show = function (wrapper) {
	wrapper.quality_oqc_terminal?.handle_route_options();
	wrapper.quality_oqc_terminal?.refresh();
};

const JCE_OQC_STATE_KEY = "jce_quality_oqc_terminal_filters";

class QualityOQCTerminal {
	constructor(page) {
		this.page = page;
		this.canUseDeliveryPlan = can_read_doctype("Delivery Plan");
		this.filters = {
			source_type: "Delivery Note",
			from_date: frappe.datetime.add_days(frappe.datetime.get_today(), -7),
			to_date: frappe.datetime.get_today(),
			customer: "",
			delivery_note: "",
			delivery_plan: "",
		};
		Object.assign(this.filters, this.get_stored_filters(), this.consume_route_options());
		this.normalize_filters();
		this.deliveryNotes = [];
		this.oqcItems = [];
		this.controls = {};
		this.setup();
	}

	setup() {
		this.page.set_primary_action(__("Refresh"), () => this.refresh(), "refresh");
		this.page.add_menu_item(__("Inspection Terminal"), () => frappe.set_route("quality-inspection-terminal"));
		this.body = $(`
			<div class="jce-oqc-terminal">
				<section class="jce-oqc-header">
					<div>
						<span>${__("Quality Inspection")}</span>
						<h2>${__("OQC Shipping Inspection")}</h2>
					</div>
					<button class="jce-oqc-button subtle" data-action="inspection-terminal">${__("Inspection Terminal")}</button>
				</section>
				<section class="jce-oqc-filter-panel">
					<div class="jce-oqc-filters"></div>
					<button class="jce-oqc-button primary" data-action="load">${__("Load")}</button>
				</section>
				<section class="jce-oqc-layout">
					<div class="jce-oqc-list-panel">
						<div class="jce-oqc-section-head">
							<span>${__("Delivery Note List")}</span>
							<b class="jce-oqc-count">0</b>
						</div>
						<div class="jce-oqc-delivery-list"></div>
					</div>
					<div class="jce-oqc-items-panel">
						<div class="jce-oqc-section-head">
							<span>${__("OQC Items")}</span>
							<button class="jce-oqc-button subtle" data-action="clear-delivery-note">${__("Back to Delivery Note List")}</button>
						</div>
						<div class="jce-oqc-items"></div>
					</div>
				</section>
			</div>
		`).appendTo(this.page.body);
		this.inject_style();
		this.render_filters();
		this.body.find('[data-action="load"]').on("click", () => this.refresh());
		this.body.find('[data-action="inspection-terminal"]').on("click", () => frappe.set_route("quality-inspection-terminal"));
		this.body.find('[data-action="clear-delivery-note"]').on("click", () => this.select_delivery_note(""));
	}

	handle_route_options() {
		const routeOptions = this.consume_route_options();
		if (!Object.keys(routeOptions).length) return;
		Object.assign(this.filters, routeOptions);
		this.normalize_filters();
		this.sync_controls();
		this.store_filters();
	}

	consume_route_options() {
		const options = clean_route_options(frappe.route_options || {});
		frappe.route_options = null;
		return options;
	}

	get_stored_filters() {
		try {
			return JSON.parse(localStorage.getItem(JCE_OQC_STATE_KEY) || "{}") || {};
		} catch (error) {
			console.error(error);
			return {};
		}
	}

	store_filters() {
		try {
			localStorage.setItem(JCE_OQC_STATE_KEY, JSON.stringify(this.filters));
		} catch (error) {
			console.error(error);
		}
	}

	normalize_filters() {
		if (!this.canUseDeliveryPlan && this.filters.source_type === "Delivery Plan") {
			this.filters.source_type = "Delivery Note";
			this.filters.delivery_plan = "";
		}
		this.filters.source_type = this.filters.source_type || "Delivery Note";
	}

	render_filters() {
		const filterBar = this.body.find(".jce-oqc-filters");
		filterBar.empty();
		const sourceOptions = this.canUseDeliveryPlan ? "Delivery Note\nDelivery Plan" : "Delivery Note";
		const fields = [
			{ fieldname: "source_type", label: __("Source"), fieldtype: "Select", options: sourceOptions, default: this.filters.source_type },
			{ fieldname: "delivery_note", label: __("Delivery Note"), fieldtype: "Link", options: "Delivery Note", default: this.filters.delivery_note },
			{ fieldname: "delivery_plan", label: __("Delivery Plan"), fieldtype: "Link", options: "Delivery Plan", default: this.filters.delivery_plan },
			{ fieldname: "customer", label: __("Customer"), fieldtype: "Link", options: "Customer", default: this.filters.customer },
			{ fieldname: "from_date", label: __("From Date"), fieldtype: "Date", default: this.filters.from_date },
			{ fieldname: "to_date", label: __("To Date"), fieldtype: "Date", default: this.filters.to_date },
		];
		fields.forEach((df) => {
			if (df.fieldname === "delivery_plan" && !this.canUseDeliveryPlan) return;
			const holder = $('<div class="jce-oqc-filter"></div>').appendTo(filterBar);
			const control = frappe.ui.form.make_control({ parent: holder, df, render_input: true });
			control.set_value(df.default || "");
			control.$input.on("change", () => {
				this.filters[df.fieldname] = control.get_value();
				if (df.fieldname === "source_type") this.normalize_filters();
				if (df.fieldname === "delivery_note") this.select_delivery_note(control.get_value(), { refreshList: true });
				else {
					this.store_filters();
					this.update_filter_visibility();
				}
			});
			this.controls[df.fieldname] = control;
		});
		this.update_filter_visibility();
	}

	sync_controls() {
		Object.entries(this.controls).forEach(([fieldname, control]) => {
			control.set_value(this.filters[fieldname] || "");
		});
		this.update_filter_visibility();
	}

	update_filter_visibility() {
		const sourceType = this.filters.source_type || "Delivery Note";
		this.controls.delivery_plan?.$wrapper.toggle(this.canUseDeliveryPlan && sourceType === "Delivery Plan");
	}

	refresh() {
		this.normalize_filters();
		this.store_filters();
		this.render_delivery_loading();
		const args = {
			from_date: this.filters.from_date,
			to_date: this.filters.to_date,
			customer: this.filters.customer,
			delivery_note: this.filters.delivery_note,
			delivery_plan: this.filters.source_type === "Delivery Plan" ? this.filters.delivery_plan : "",
		};
		if (this.filters.source_type === "Delivery Plan" && !this.filters.delivery_plan) {
			this.deliveryNotes = [];
			this.render_delivery_notes([]);
			this.render_items_empty(__("Select Delivery Plan."));
			return Promise.resolve();
		}
		return frappe.call({
			method: "jce_quality.api.quality.get_delivery_oqc_delivery_notes",
			args,
			freeze: true,
			freeze_message: __("Loading Delivery Notes..."),
		}).then((r) => {
			this.deliveryNotes = r.message || [];
			this.render_delivery_notes(this.deliveryNotes);
			if (this.filters.delivery_note) {
				return this.load_items(this.filters.delivery_note);
			}
			this.render_items_empty(__("Select Delivery Note."));
		});
	}

	render_delivery_loading() {
		this.body.find(".jce-oqc-count").text("...");
		this.body.find(".jce-oqc-delivery-list").html(`<div class="jce-oqc-empty">${__("Loading...")}</div>`);
	}

	render_delivery_notes(rows) {
		this.body.find(".jce-oqc-count").text(rows.length);
		const list = this.body.find(".jce-oqc-delivery-list");
		if (!rows.length) {
			list.html(`<div class="jce-oqc-empty">${__("No Delivery Notes found.")}</div>`);
			return;
		}
		list.html(rows.map((row) => {
			const active = row.name === this.filters.delivery_note ? "active" : "";
			return `
				<button class="jce-oqc-delivery-row ${active}" data-delivery-note="${esc(row.name || "")}">
					<span>
						<b>${esc(row.name || "")}</b>
						<em>${esc(row.customer || "-")}</em>
					</span>
					<span>
						<strong>${esc(row.posting_date || "-")}</strong>
						<small>${esc(row.status || "-")}</small>
					</span>
				</button>
			`;
		}).join(""));
		list.find("[data-delivery-note]").on("click", (event) => {
			this.select_delivery_note(event.currentTarget.dataset.deliveryNote);
		});
	}

	select_delivery_note(deliveryNote, options = {}) {
		this.filters.delivery_note = deliveryNote || "";
		this.controls.delivery_note?.set_value(this.filters.delivery_note);
		this.store_filters();
		this.render_delivery_notes(this.deliveryNotes || []);
		if (!this.filters.delivery_note) {
			this.render_items_empty(__("Select Delivery Note."));
			if (options.refreshList) this.refresh();
			return;
		}
		if (options.refreshList) {
			this.refresh();
			return;
		}
		this.load_items(this.filters.delivery_note);
	}

	load_items(deliveryNote) {
		this.body.find(".jce-oqc-items").html(`<div class="jce-oqc-empty">${__("Loading...")}</div>`);
		return frappe.call({
			method: "jce_quality.api.quality.get_delivery_oqc_items",
			args: { delivery_note: deliveryNote },
			freeze: true,
			freeze_message: __("Loading OQC Items..."),
		}).then((r) => {
			this.oqcItems = r.message || [];
			this.render_items(this.oqcItems);
		});
	}

	render_items_empty(message) {
		this.body.find(".jce-oqc-items").html(`<div class="jce-oqc-empty">${esc(message)}</div>`);
	}

	render_items(rows) {
		const holder = this.body.find(".jce-oqc-items");
		if (!rows.length) {
			holder.html(`<div class="jce-oqc-empty">${__("No Delivery Note items found.")}</div>`);
			return;
		}
		holder.html(`
			<div class="jce-oqc-item-table">
				${rows.map((row) => this.render_item_row(row)).join("")}
			</div>
		`);
		holder.find("[data-oqc-open]").on("click", (event) => {
			const button = $(event.currentTarget);
			this.open_oqc_check({
				delivery_note: this.filters.delivery_note,
				item_code: button.data("itemCode"),
				warehouse: button.data("warehouse") || "",
				uom: button.data("uom") || "",
			});
		});
	}

	render_item_row(row) {
		const hasCheck = !!row.check_name;
		const ruleNote = row.production_quality_rule
			? `<span class="jce-oqc-rule">${esc(row.production_quality_rule)}${row.quality_inspection_template ? ` · ${esc(row.quality_inspection_template)}` : ""}</span>`
			: `<span class="jce-oqc-rule warn">${__("No OQC rule configured. Manual inspection is allowed.")}</span>`;
		return `
			<div class="jce-oqc-item-row">
				<div class="jce-oqc-item-main">
					<b>${esc(row.item_code || "")}</b>
					<span>${esc(row.item_name || "")}</span>
					<em>${esc(row.warehouse || "-")} · ${esc(row.uom || "-")} · ${format_float(row.qty || 0)}</em>
					${ruleNote}
				</div>
				<div class="jce-oqc-item-status">
					<span class="jce-oqc-pill">${esc(row.check_name || "-")}</span>
					<span class="jce-oqc-pill ${status_tone(row.overall_status)}">${esc(inspection_status_label(row.overall_status || "Pending"))}</span>
					<span class="jce-oqc-pill ${release_tone(row.release_status)}">${esc(oqc_release_status_label(row.release_status || "Pending"))}</span>
					<button class="jce-oqc-button primary" data-oqc-open="1" data-item-code="${esc(row.item_code || "")}" data-warehouse="${esc(row.warehouse || "")}" data-uom="${esc(row.uom || "")}">
						${hasCheck ? __("Open OQC") : __("Create OQC")}
					</button>
				</div>
			</div>
		`;
	}

	open_oqc_check(args) {
		frappe.call({
			method: "jce_quality.api.quality.get_or_create_delivery_oqc_check",
			args,
			freeze: true,
			freeze_message: __("Opening OQC..."),
		}).then((r) => {
			const checkName = r.message?.name;
			if (!checkName) return;
			frappe.route_options = { check_name: checkName };
			frappe.set_route("quality-inspection-terminal");
		});
	}

	inject_style() {
		if (document.getElementById("jce-quality-oqc-style")) return;
		$(`<style id="jce-quality-oqc-style">
			.jce-oqc-terminal {
				--jce-oqc-bg: #f5f5f7;
				--jce-oqc-surface: #fff;
				--jce-oqc-line: rgba(0, 0, 0, 0.08);
				--jce-oqc-line-soft: rgba(0, 0, 0, 0.05);
				--jce-oqc-text: #1d1d1f;
				--jce-oqc-muted: #6e6e73;
				--jce-oqc-blue: #0071e3;
				--jce-oqc-green: #248a3d;
				--jce-oqc-orange: #b65a00;
				--jce-oqc-red: #c01f2f;
				min-height: calc(100vh - 86px);
				padding: 14px;
				background: var(--jce-oqc-bg);
				color: var(--jce-oqc-text);
				font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			}
			.jce-oqc-header,
			.jce-oqc-filter-panel,
			.jce-oqc-list-panel,
			.jce-oqc-items-panel {
				border: 1px solid var(--jce-oqc-line-soft);
				border-radius: 8px;
				background: rgba(255, 255, 255, 0.86);
				box-shadow: 0 10px 30px rgba(0, 0, 0, 0.04);
			}
			.jce-oqc-header {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 12px;
				margin-bottom: 10px;
				padding: 12px;
			}
			.jce-oqc-header span,
			.jce-oqc-section-head span {
				display: block;
				color: var(--jce-oqc-muted);
				font-size: 11px;
				font-weight: 800;
				text-transform: uppercase;
			}
			.jce-oqc-header h2 {
				margin: 2px 0 0;
				font-size: 22px;
				font-weight: 850;
				letter-spacing: 0;
			}
			.jce-oqc-filter-panel {
				display: flex;
				align-items: flex-end;
				gap: 10px;
				margin-bottom: 10px;
				padding: 10px;
			}
			.jce-oqc-filters {
				display: grid;
				grid-template-columns: repeat(6, minmax(150px, 1fr));
				gap: 8px;
				flex: 1 1 auto;
			}
			.jce-oqc-filter .control-label {
				color: var(--jce-oqc-muted);
				font-size: 11px;
				font-weight: 750;
			}
			.jce-oqc-layout {
				display: grid;
				grid-template-columns: minmax(300px, 380px) minmax(0, 1fr);
				gap: 10px;
			}
			.jce-oqc-list-panel,
			.jce-oqc-items-panel {
				min-height: 58vh;
				padding: 10px;
			}
			.jce-oqc-section-head {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 10px;
				margin-bottom: 8px;
			}
			.jce-oqc-section-head b {
				font-size: 18px;
			}
			.jce-oqc-delivery-list,
			.jce-oqc-items {
				display: grid;
				gap: 8px;
			}
			.jce-oqc-delivery-row,
			.jce-oqc-item-row {
				width: 100%;
				border: 1px solid var(--jce-oqc-line-soft);
				border-radius: 8px;
				background: #fff;
				text-align: left;
			}
			.jce-oqc-delivery-row {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 10px;
				padding: 10px;
				transition: border-color .16s ease, box-shadow .16s ease;
			}
			.jce-oqc-delivery-row.active {
				border-color: rgba(0, 113, 227, 0.36);
				box-shadow: inset 3px 0 0 var(--jce-oqc-blue);
			}
			.jce-oqc-delivery-row b,
			.jce-oqc-delivery-row em,
			.jce-oqc-delivery-row strong,
			.jce-oqc-delivery-row small,
			.jce-oqc-item-main b,
			.jce-oqc-item-main span,
			.jce-oqc-item-main em {
				display: block;
			}
			.jce-oqc-delivery-row em,
			.jce-oqc-delivery-row small,
			.jce-oqc-item-main em,
			.jce-oqc-rule {
				color: var(--jce-oqc-muted);
				font-style: normal;
				font-size: 12px;
			}
			.jce-oqc-item-row {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 12px;
				padding: 12px;
			}
			.jce-oqc-item-main {
				min-width: 0;
			}
			.jce-oqc-rule {
				margin-top: 4px;
			}
			.jce-oqc-rule.warn {
				color: var(--jce-oqc-orange);
				font-weight: 700;
			}
			.jce-oqc-item-status {
				display: flex;
				align-items: center;
				justify-content: flex-end;
				flex-wrap: wrap;
				gap: 6px;
			}
			.jce-oqc-pill {
				min-height: 28px;
				display: inline-flex;
				align-items: center;
				padding: 5px 8px;
				border-radius: 8px;
				background: #f5f5f7;
				color: var(--jce-oqc-muted);
				font-size: 12px;
				font-weight: 750;
			}
			.jce-oqc-pill.ok { background: #ecf9f0; color: var(--jce-oqc-green); }
			.jce-oqc-pill.warn { background: #fff6e5; color: var(--jce-oqc-orange); }
			.jce-oqc-pill.danger { background: #fff1f2; color: var(--jce-oqc-red); }
			.jce-oqc-button {
				min-height: 34px;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				padding: 7px 12px;
				border: 1px solid var(--jce-oqc-line);
				border-radius: 8px;
				background: #fff;
				color: var(--jce-oqc-text);
				font-weight: 760;
				white-space: nowrap;
			}
			.jce-oqc-button.primary {
				border-color: var(--jce-oqc-blue);
				background: var(--jce-oqc-blue);
				color: #fff;
			}
			.jce-oqc-button.subtle {
				background: #f5f5f7;
			}
			.jce-oqc-empty {
				padding: 24px;
				border: 1px dashed var(--jce-oqc-line);
				border-radius: 8px;
				color: var(--jce-oqc-muted);
				text-align: center;
				font-weight: 700;
			}
			@media (max-width: 1024px) {
				.jce-oqc-filters {
					grid-template-columns: repeat(3, minmax(150px, 1fr));
				}
				.jce-oqc-layout {
					grid-template-columns: 1fr;
				}
				.jce-oqc-list-panel,
				.jce-oqc-items-panel {
					min-height: auto;
				}
			}
			@media (max-width: 640px) {
				.jce-oqc-terminal { padding: 10px; }
				.jce-oqc-header,
				.jce-oqc-filter-panel,
				.jce-oqc-item-row {
					align-items: stretch;
					flex-direction: column;
				}
				.jce-oqc-filters {
					grid-template-columns: 1fr;
				}
				.jce-oqc-item-status {
					justify-content: flex-start;
				}
			}
		</style>`).appendTo(document.head);
	}
}

function can_read_doctype(doctype) {
	try {
		return frappe.model.can_read(doctype);
	} catch (error) {
		console.error(error);
		return false;
	}
}

function clean_route_options(options) {
	const cleaned = {};
	Object.keys(options || {}).forEach((key) => {
		let value = options[key];
		if (typeof value === "string" && (value.startsWith('"') || value.startsWith("["))) {
			try {
				value = JSON.parse(value);
			} catch (error) {
				console.error(error);
			}
		}
		cleaned[key] = value;
	});
	return cleaned;
}

function esc(value) {
	return frappe.utils.escape_html(String(value ?? ""));
}

function format_float(value) {
	return frappe.format(value || 0, { fieldtype: "Float" });
}

function status_tone(status) {
	if (status === "Rejected") return "danger";
	if (status === "Accepted" || status === "Concession Released") return "ok";
	return "";
}

function release_tone(status) {
	if (status === "Released") return "ok";
	if (status === "Temporary Released") return "warn";
	if (status === "Blocked") return "danger";
	return "";
}

function inspection_status_label(status) {
	if (status === "Rejected") return "NG";
	if (status === "Accepted" || status === "Concession Released") return "OK";
	return __("Pending");
}

function oqc_release_status_label(status) {
	const labels = {
		Pending: __("Pending"),
		Released: __("Released"),
		"Temporary Released": __("OQC Temporary Released"),
		Blocked: __("OQC Blocked"),
	};
	return labels[status] || __(status || "");
}
