frappe.pages["quality-inspection-terminal"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Quality Inspection Terminal"),
		single_column: true,
	});
	wrapper.quality_terminal = new QualityInspectionTerminal(page, wrapper);
};

frappe.pages["quality-inspection-terminal"].on_page_show = function (wrapper) {
	wrapper.quality_terminal?.refresh();
};

class QualityInspectionTerminal {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = $(wrapper);
		this.filters = {
			posting_date: frappe.datetime.get_today(),
			plant_floor: "",
			shift_type: "",
		};
		this.defect_options = [];
		Object.assign(this.filters, clean_route_options(frappe.route_options || {}));
		frappe.route_options = null;
		this.setup();
	}

	setup() {
		this.page.set_primary_action(__("Refresh"), () => this.refresh(), "refresh");
		this.body = $(`
			<div class="jce-q-terminal">
				<div class="jce-q-toolbar"></div>
				<div class="jce-q-layout">
					<div class="jce-q-task-list"></div>
					<div class="jce-q-detail">
						<div class="jce-q-empty">${__("Select a quality task to start inspection.")}</div>
					</div>
				</div>
			</div>
		`).appendTo(this.page.body);
		this.inject_style();
		this.render_filters();
		this.load_defect_options();
	}

	render_filters() {
		const toolbar = this.body.find(".jce-q-toolbar");
		toolbar.empty();
		const fields = [
			{ fieldname: "posting_date", label: __("Date"), fieldtype: "Date", default: this.filters.posting_date },
			{ fieldname: "plant_floor", label: __("Plant Floor"), fieldtype: "Link", options: "Plant Floor", default: this.filters.plant_floor },
			{ fieldname: "shift_type", label: __("Shift"), fieldtype: "Select", options: "\n白班\n晚班", default: this.filters.shift_type },
		];
		this.controls = {};
		fields.forEach((df) => {
			const holder = $('<div class="jce-q-filter"></div>').appendTo(toolbar);
			const control = frappe.ui.form.make_control({
				parent: holder,
				df,
				render_input: true,
			});
			control.set_value(df.default || "");
			control.$input.on("change", () => {
				this.filters[df.fieldname] = control.get_value();
				this.refresh();
			});
			this.controls[df.fieldname] = control;
		});
		$(`<button class="btn btn-primary">${__("Load Tasks")}</button>`)
			.appendTo(toolbar)
			.on("click", () => this.refresh());
	}

	refresh() {
		frappe.call({
			method: "jce_quality.api.quality.get_terminal_task_list",
			args: this.filters,
			freeze: true,
			freeze_message: __("Loading quality tasks..."),
		}).then((r) => {
			this.tasks = r.message || [];
			this.render_tasks();
		});
	}

	load_defect_options() {
		frappe.call({
			method: "jce_quality.api.quality.get_defect_code_options",
		}).then((r) => {
			this.defect_options = r.message || [];
			let datalist = document.getElementById("jce-q-defect-options");
			if (!datalist) {
				datalist = document.createElement("datalist");
				datalist.id = "jce-q-defect-options";
				document.body.appendChild(datalist);
			}
			datalist.innerHTML = this.defect_options
				.map((row) => `<option value="${esc(row.defect_code)}">${esc(row.defect_name || row.defect_code)}</option>`)
				.join("");
		});
	}

	render_tasks() {
		const list = this.body.find(".jce-q-task-list");
		list.empty();
		if (!this.tasks.length) {
			list.html(`<div class="jce-q-empty">${__("No tasks found.")}</div>`);
			return;
		}

		this.tasks.forEach((task) => {
			const frozen = task.frozen ? `<span class="jce-q-pill danger">${__("NG Frozen")}</span>` : "";
			const patrol_complete = cint(task.patrol_count) >= cint(task.patrol_required_count);
			const patrol_status = !cint(task.patrol_required_count)
				? "Not Required"
				: task.patrol_overdue
					? "Overdue"
					: patrol_complete
						? "Accepted"
						: `${cint(task.patrol_count)} / ${cint(task.patrol_required_count)}`;
			const first_article_status = cint(task.first_article_required) ? task.first_article_status : "Not Required";
			const last_article_status = cint(task.last_article_required) ? task.last_article_status : "Not Required";
			const final_release_status = cint(task.final_release_required) ? task.final_release_status : "Not Required";
			const row = $(`
				<div class="jce-q-task">
					<div class="jce-q-task-title">${esc(task.item_code)} <span>${esc(task.workstation || "-")}</span></div>
					<div class="jce-q-task-sub">${esc(task.item_name || "")}</div>
					<div class="jce-q-task-meta">
						<span>${__("WO")}: ${esc(task.work_order || "-")}</span>
						<span>${__("Qty")}: ${frappe.format(task.scheduling_qty || 0, { fieldtype: "Float" })}</span>
						${frozen}
						</div>
						<div class="jce-q-node-row">
							${this.node_button(task, "First Article", first_article_status)}
							${this.node_button(task, "Patrol", patrol_status)}
							${this.node_button(task, "Last Article", last_article_status)}
							${this.node_button(task, "Final Release", final_release_status)}
						</div>
					</div>
				`).appendTo(list);
			row.find("[data-node]").on("click", (event) => {
				event.stopPropagation();
				this.open_check(task, event.currentTarget.dataset.node);
			});
		});
	}

	node_button(task, node, status) {
		const tone = status === "Accepted" || status === "Concession Released" ? "ok" : ["Rejected", "Overdue"].includes(status) ? "danger" : status === "Not Required" ? "" : "warn";
		const disabled = status === "Not Required" ? "disabled" : "";
		return `<button class="jce-q-node ${tone}" data-node="${esc(node)}" ${disabled}>${esc(__(node))}<b>${esc(__(status || "Pending"))}</b></button>`;
	}

	open_check(task, node) {
		frappe.call({
			method: "jce_quality.api.quality.get_or_create_check",
			args: {
				work_order_scheduling: task.work_order_scheduling,
				scheduling_item: task.name,
				quality_node: node,
			},
			freeze: true,
			freeze_message: __("Opening inspection..."),
		}).then((r) => {
			this.current = r.message;
			this.render_check();
		});
	}

	render_check() {
		const doc = this.current;
		const detail = this.body.find(".jce-q-detail");
		const submitted = cint(doc.docstatus) > 0;
		detail.empty();
		const readings = (doc.readings || []).map((row) => this.render_reading(row, submitted)).join("");
		const defects = this.render_defects(doc, submitted);
		const photos = this.render_photos(doc, submitted);
		const draft_actions = !submitted
			? `<button class="btn btn-default" data-action="start">${__("Start Inspection")}</button>
				<button class="btn btn-secondary" data-action="attach">${__("Attach Photo")}</button>
				<button class="btn btn-warning" data-action="mark-ng">${__("Mark NG")}</button>
				<button class="btn btn-default" data-action="save">${__("Save Draft")}</button>
				<button class="btn btn-primary" data-action="submit">${__("Submit Inspection")}</button>`
			: `<button class="btn btn-secondary" data-action="attach">${__("Attach Photo")}</button>
				${doc.overall_status === "Rejected" && doc.disposition !== "Concession Release" ? `<button class="btn btn-warning" data-action="concession">${__("Apply Concession Release")}</button>` : ""}
				<button class="btn btn-default" data-action="open-form">${__("Open Form")}</button>`;
		detail.html(`
			<div class="jce-q-detail-head">
				<div>
					<div class="jce-q-kicker">${esc(doc.quality_node)} · ${esc(doc.name)}</div>
					<h3>${esc(doc.item_code)} ${esc(doc.item_name || "")}</h3>
					<p>${__("Workstation")}: ${esc(doc.workstation || "-")} · ${__("Shift")}: ${esc(doc.shift_type || "-")} · ${__("Qty")}: ${esc(doc.scheduling_qty || 0)}</p>
				</div>
				<span class="jce-q-pill ${status_tone(doc.overall_status)}">${esc(__(doc.overall_status || "Pending"))}</span>
			</div>
			<div class="jce-q-sample">
				<label>${__("Sample Manager")}</label>
				<input class="form-control" data-field="sample_manager" value="${esc(doc.sample_manager || "")}" ${submitted ? "disabled" : ""}>
				<div>${__("Required")}: ${doc.requires_sample ? __("Yes") : __("No")} ${doc.required_sample_type ? " · " + esc(doc.required_sample_type) : ""}</div>
			</div>
			<div class="jce-q-readings">${readings || `<div class="jce-q-empty">${__("No template readings. Use Manual Result before submit.")}</div>`}</div>
			<div class="jce-q-subhead">
				<b>${__("Defects")}</b>
				${submitted ? "" : `<button class="btn btn-xs btn-default" data-action="add-defect">${__("Add Defect")}</button>`}
			</div>
			<div class="jce-q-defects">${defects}</div>
			<div class="jce-q-subhead">
				<b>${__("Defect Photos")}</b>
				<button class="btn btn-xs btn-default" data-action="attach">${__("Attach Photo")}</button>
			</div>
			<div class="jce-q-photos">${photos}</div>
			<div class="jce-q-actions">
				<label class="checkbox"><input type="checkbox" data-field="manual_inspection" ${doc.manual_inspection ? "checked" : ""} ${submitted ? "disabled" : ""}> ${__("Manual Result")}</label>
				<select class="form-control" data-field="overall_status" ${submitted ? "disabled" : ""}>
					${["Pending", "Accepted", "Rejected"].map((value) => `<option value="${value}" ${doc.overall_status === value ? "selected" : ""}>${__(value)}</option>`).join("")}
				</select>
				<textarea class="form-control" data-field="remarks" placeholder="${__("Remarks")}" ${submitted ? "disabled" : ""}>${esc(doc.remarks || "")}</textarea>
				${draft_actions}
			</div>
		`);

		detail.find('[data-action="start"]').on("click", () => this.start_check());
		detail.find('[data-action="save"]').on("click", () => this.save_check(false));
		detail.find('[data-action="submit"]').on("click", () => this.save_check(true));
		detail.find('[data-action="mark-ng"]').on("click", () => this.mark_ng());
		detail.find('[data-action="concession"]').on("click", () => this.apply_concession());
		detail.find('[data-action="add-defect"]').on("click", () => this.add_defect_row());
		detail.find('[data-action="remove-defect"]').on("click", (event) => $(event.currentTarget).closest(".jce-q-defect-row").remove());
		detail.find('[data-action="remove-photo"]').on("click", (event) => $(event.currentTarget).closest(".jce-q-photo").remove());
		detail.find('[data-action="open-form"]').on("click", () => frappe.set_route("Form", "Production Quality Check", doc.name));
		detail.find('[data-action="attach"]').on("click", () => this.attach_photo());
		if (!submitted && !doc.inspection_started_at) {
			frappe.call({ method: "jce_quality.api.quality.start_check", args: { check_name: doc.name } });
		}
	}

	render_defects(doc, submitted) {
		const rows = doc.defects || [];
		if (!rows.length && submitted) {
			return `<div class="jce-q-empty compact">${__("No defects recorded.")}</div>`;
		}
		return rows.map((row) => this.defect_row(row, submitted)).join("") || `<div class="jce-q-empty compact">${__("No defects recorded.")}</div>`;
	}

	defect_row(row = {}, submitted = false) {
		return `
			<div class="jce-q-defect-row">
				<input class="form-control" list="jce-q-defect-options" data-field="defect_code" value="${esc(row.defect_code || "")}" placeholder="${__("Defect Code")}" ${submitted ? "disabled" : ""}>
				<input class="form-control" data-field="quantity" type="number" min="0" step="1" value="${esc(row.quantity || 1)}" ${submitted ? "disabled" : ""}>
				<input class="form-control" data-field="remarks" value="${esc(row.remarks || "")}" placeholder="${__("Remarks")}" ${submitted ? "disabled" : ""}>
				${submitted ? `<span class="jce-q-muted">${esc(row.defect_name || "")}</span>` : `<button class="btn btn-xs btn-default" data-action="remove-defect">${__("Remove")}</button>`}
			</div>
		`;
	}

	render_photos(doc, submitted) {
		const photos = [...(doc.defect_photos || [])];
		if (doc.inspection_photo && !photos.some((row) => row.image === doc.inspection_photo)) {
			photos.unshift({ image: doc.inspection_photo, caption: __("Legacy Photo") });
		}
		if (!photos.length) {
			return `<div class="jce-q-empty compact">${__("No photos attached.")}</div>`;
		}
		return photos.map((row) => this.photo_row(row, submitted)).join("");
	}

	photo_row(row = {}, submitted = false) {
		return `
			<div class="jce-q-photo">
				<a href="${esc(row.image)}" target="_blank" rel="noreferrer"><img src="${esc(row.image)}" alt="${esc(row.caption || "")}"></a>
				<input class="form-control" data-field="caption" value="${esc(row.caption || "")}" placeholder="${__("Caption")}" ${submitted ? "disabled" : ""}>
				<input type="hidden" data-field="image" value="${esc(row.image || "")}">
				${submitted ? "" : `<button class="btn btn-xs btn-default" data-action="remove-photo">${__("Remove")}</button>`}
			</div>
		`;
	}

	render_reading(row, submitted) {
		const criteria = row.numeric
			? `${__("Min")}: ${esc(row.min_value ?? "")} · ${__("Max")}: ${esc(row.max_value ?? "")}`
			: `${__("Value")}: ${esc(row.value || "")}`;
		const inputs = row.numeric
			? Array.from({ length: 10 }, (_, idx) => {
					const field = `reading_${idx + 1}`;
					return `<input data-reading="${row.idx}" data-field="${field}" value="${esc(row[field] || "")}" ${submitted ? "disabled" : ""}>`;
			  }).join("")
			: `<input class="wide" data-reading="${row.idx}" data-field="reading_value" value="${esc(row.reading_value || "")}" ${submitted ? "disabled" : ""}>`;

		return `
			<div class="jce-q-reading">
				<div>
					<b>${esc(row.specification)}</b>
					<span>${criteria}</span>
				</div>
				<div class="jce-q-reading-inputs">${inputs}</div>
			</div>
		`;
	}

	collect_payload() {
		const detail = this.body.find(".jce-q-detail");
		const readings = [];
		detail.find("[data-reading]").each((_, node) => {
			const input = $(node);
			const idx = cint(input.data("reading"));
			let row = readings.find((item) => item.idx === idx);
			if (!row) {
				row = { idx };
				readings.push(row);
			}
			row[input.data("field")] = input.val();
		});
		const defects = [];
		detail.find(".jce-q-defect-row").each((_, node) => {
			const row = $(node);
			const defect_code = row.find('[data-field="defect_code"]').val();
			if (!defect_code) return;
			defects.push({
				defect_code,
				quantity: row.find('[data-field="quantity"]').val() || 1,
				remarks: row.find('[data-field="remarks"]').val(),
			});
		});
		const defect_photos = [];
		detail.find(".jce-q-photo").each((_, node) => {
			const row = $(node);
			const image = row.find('[data-field="image"]').val();
			if (!image) return;
			defect_photos.push({
				image,
				caption: row.find('[data-field="caption"]').val(),
			});
		});
		return {
			check_name: this.current.name,
			sample_manager: detail.find('[data-field="sample_manager"]').val(),
			manual_inspection: detail.find('[data-field="manual_inspection"]').is(":checked") ? 1 : 0,
			overall_status: detail.find('[data-field="overall_status"]').val(),
			remarks: detail.find('[data-field="remarks"]').val(),
			readings,
			defects,
			defect_photos,
		};
	}

	save_check(submit) {
		const payload = this.collect_payload();
		frappe.call({
			method: submit ? "jce_quality.api.quality.submit_check" : "jce_quality.api.quality.save_check",
			args: payload,
			freeze: true,
			freeze_message: submit ? __("Submitting inspection...") : __("Saving draft..."),
		}).then((r) => {
			this.current = r.message;
			this.render_check();
			this.refresh();
		});
	}

	start_check() {
		frappe.call({
			method: "jce_quality.api.quality.start_check",
			args: { check_name: this.current.name },
		}).then((r) => {
			this.current = r.message;
			this.render_check();
		});
	}

	mark_ng() {
		const detail = this.body.find(".jce-q-detail");
		detail.find('[data-field="manual_inspection"]').prop("checked", true);
		detail.find('[data-field="overall_status"]').val("Rejected");
		this.save_check(false);
	}

	add_defect_row() {
		const container = this.body.find(".jce-q-defects");
		container.find(".jce-q-empty").remove();
		const row = $(this.defect_row({}, false)).appendTo(container);
		row.find('[data-action="remove-defect"]').on("click", () => row.remove());
	}

	apply_concession() {
		frappe.prompt(
			[{ fieldname: "remarks", fieldtype: "Small Text", label: __("Remarks") }],
			(values) => {
				frappe.call({
					method: "jce_quality.api.quality.set_disposition",
					args: {
						check_name: this.current.name,
						disposition: "Concession Release",
						remarks: values.remarks,
					},
					freeze: true,
					freeze_message: __("Applying concession release..."),
				}).then((r) => {
					this.current = r.message;
					this.render_check();
					this.refresh();
				});
			},
			__("Apply Concession Release")
		);
	}

	attach_photo() {
		new frappe.ui.FileUploader({
			doctype: "Production Quality Check",
			docname: this.current.name,
			folder: "Home/Attachments",
			on_success: (file) => {
				const payload = this.collect_payload();
				payload.defect_photos.push({ image: file.file_url, caption: "" });
				frappe.call({
					method: "jce_quality.api.quality.save_check",
					args: this.current.docstatus ? { check_name: this.current.name, defect_photos: [{ image: file.file_url, caption: "" }] } : payload,
				}).then((r) => {
					this.current = r.message;
					frappe.show_alert({ message: __("Photo attached."), indicator: "green" });
					this.render_check();
				});
			},
		});
	}

	inject_style() {
		if (document.getElementById("jce-quality-terminal-style")) return;
		$(`<style id="jce-quality-terminal-style">
			.jce-q-terminal {
				display: flex;
				flex-direction: column;
				gap: 14px;
				min-height: calc(100vh - 120px);
				padding: 8px 0 20px;
			}
			.jce-q-toolbar {
				display: flex;
				gap: 10px;
				align-items: end;
				flex-wrap: wrap;
				border: 1px solid #d8dee9;
				border-radius: 16px;
				padding: 12px 14px;
				background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
			}
			.jce-q-filter { min-width: 180px; }
			.jce-q-layout {
				display: grid;
				grid-template-columns: minmax(340px, 38%) 1fr;
				gap: 14px;
				align-items: start;
			}
			.jce-q-task-list,
			.jce-q-detail {
				border: 1px solid #d8dee9;
				border-radius: 18px;
				background: #fff;
				min-height: 360px;
			}
			.jce-q-task-list {
				display: flex;
				flex-direction: column;
				gap: 10px;
				padding: 10px;
				max-height: calc(100vh - 220px);
				overflow: auto;
				background: linear-gradient(180deg, #ffffff 0%, #fbfcfd 100%);
			}
			.jce-q-task {
				border: 1px solid #e2e8f0;
				border-radius: 14px;
				padding: 12px;
				background: #fff;
				transition: border-color 0.15s ease, box-shadow 0.15s ease;
			}
			.jce-q-task:hover {
				border-color: #bfd3ff;
				box-shadow: 0 8px 20px rgba(15, 23, 42, 0.05);
			}
			.jce-q-task-title {
				font-weight: 700;
				font-size: 15px;
				display: flex;
				justify-content: space-between;
				gap: 8px;
				color: #0f172a;
			}
			.jce-q-task-title span {
				color: #64748b;
				font-size: 12px;
				font-weight: 600;
			}
			.jce-q-task-sub,
			.jce-q-task-meta,
			.jce-q-kicker,
			.jce-q-sample div {
				color: #64748b;
				font-size: 12px;
			}
			.jce-q-task-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 5px; }
			.jce-q-node-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; margin-top: 11px; }
			.jce-q-node {
				border: 1px solid #d8dee9;
				border-radius: 12px;
				padding: 8px 4px;
				background: #f8fafc;
				font-size: 12px;
				min-height: 58px;
				color: #334155;
			}
			.jce-q-node b { display: block; font-size: 11px; margin-top: 2px; }
			.jce-q-node.ok { border-color: #b7ebc6; background: #ecfdf3; color: #107e3e; }
			.jce-q-node.warn { border-color: #fed7aa; background: #fff7ed; color: #c2410c; }
			.jce-q-node.danger { border-color: #fecdd3; background: #fff1f2; color: #be123c; }
			.jce-q-detail { padding: 16px; }
			.jce-q-detail-head {
				display: flex;
				justify-content: space-between;
				gap: 12px;
				border-bottom: 1px solid #eef2f7;
				padding-bottom: 14px;
				margin-bottom: 14px;
			}
			.jce-q-detail-head h3 { margin: 2px 0 5px; font-size: 20px; color: #0f172a; }
			.jce-q-detail-head p { color: #475569; margin: 0; }
			.jce-q-pill {
				display: inline-flex;
				align-items: center;
				border-radius: 999px;
				border: 1px solid #d3d8df;
				padding: 3px 9px;
				font-size: 11px;
				font-weight: 700;
				background: #f8fafc;
				color: #475569;
				white-space: nowrap;
				height: fit-content;
			}
			.jce-q-pill.ok { background: #ecfdf3; border-color: #b7ebc6; color: #107e3e; }
			.jce-q-pill.danger { background: #fff1f2; border-color: #fecdd3; color: #be123c; }
			.jce-q-sample {
				display: grid;
				gap: 7px;
				margin-bottom: 12px;
				border: 1px solid #e2e8f0;
				border-radius: 14px;
				padding: 12px;
				background: #fbfcfd;
			}
			.jce-q-sample label {
				font-size: 11px;
				font-weight: 700;
				text-transform: uppercase;
				letter-spacing: 0.04em;
				color: #64748b;
				margin: 0;
			}
			.jce-q-reading {
				display: grid;
				grid-template-columns: minmax(180px, 28%) 1fr;
				gap: 12px;
				border-top: 1px solid #eef2f7;
				padding: 12px 0;
			}
			.jce-q-reading b, .jce-q-reading span { display: block; }
			.jce-q-reading b { color: #1f2937; }
			.jce-q-reading span { color: #64748b; font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }
			.jce-q-reading-inputs { display: grid; grid-template-columns: repeat(5, minmax(50px, 1fr)); gap: 7px; }
			.jce-q-reading-inputs input {
				width: 100%;
				border: 1px solid #d8dee9;
				border-radius: 10px;
				padding: 9px 8px;
				background: #fff;
			}
			.jce-q-reading-inputs input.wide { grid-column: 1 / -1; }
			.jce-q-subhead {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 8px;
				border-top: 1px solid #eef2f7;
				padding-top: 12px;
				margin-top: 2px;
			}
			.jce-q-defects, .jce-q-photos {
				display: grid;
				gap: 8px;
				margin: 8px 0 12px;
			}
			.jce-q-defect-row {
				display: grid;
				grid-template-columns: minmax(140px, 1.1fr) minmax(80px, 0.4fr) minmax(160px, 1.3fr) auto;
				gap: 8px;
				align-items: center;
				border: 1px solid #e2e8f0;
				border-radius: 12px;
				padding: 8px;
				background: #fbfcfd;
			}
			.jce-q-photos {
				grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
			}
			.jce-q-photo {
				border: 1px solid #e2e8f0;
				border-radius: 12px;
				padding: 8px;
				background: #fbfcfd;
			}
			.jce-q-photo img {
				width: 100%;
				height: 110px;
				object-fit: cover;
				border-radius: 10px;
				border: 1px solid #eef2f7;
				background: #fff;
				margin-bottom: 8px;
			}
			.jce-q-muted { color: #64748b; font-size: 12px; }
			.jce-q-actions {
				display: flex;
				gap: 8px;
				align-items: center;
				flex-wrap: wrap;
				border-top: 1px solid #eef2f7;
				padding-top: 14px;
			}
			.jce-q-actions .btn { min-height: 40px; border-radius: 10px; }
			.jce-q-actions textarea { min-width: min(100%, 260px); flex: 1 1 260px; }
			.jce-q-actions select { max-width: 180px; }
			.jce-q-empty {
				padding: 28px;
				color: #64748b;
				text-align: center;
			}
			.jce-q-empty.compact { padding: 12px; border: 1px dashed #d8dee9; border-radius: 12px; }
			@media (max-width: 900px) {
				.jce-q-layout { grid-template-columns: 1fr; }
				.jce-q-task-list { max-height: none; }
				.jce-q-reading { grid-template-columns: 1fr; }
				.jce-q-node-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
				.jce-q-defect-row { grid-template-columns: 1fr; }
				.jce-q-actions .btn,
				.jce-q-actions select,
				.jce-q-actions textarea { width: 100%; max-width: none; }
			}
		</style>`).appendTo(document.head);
	}
}

function esc(value) {
	return frappe.utils.escape_html(String(value ?? ""));
}

function cint(value) {
	return parseInt(value || 0, 10) || 0;
}

function status_tone(status) {
	if (status === "Rejected") return "danger";
	if (status === "Accepted" || status === "Concession Released") return "ok";
	return "";
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
