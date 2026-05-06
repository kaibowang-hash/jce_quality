(function () {
	const root = (window.jce_quality = window.jce_quality || {});
	if (root.form_style) return;

	const SKIP_FIELD_TYPES = new Set([
		"Button",
		"Check",
		"Column Break",
		"Fold",
		"HTML",
		"Heading",
		"Image",
		"Section Break",
		"Table",
		"Tab Break",
	]);

	function icon_html(icon_name) {
		if (frappe.utils && frappe.utils.icon) {
			return frappe.utils.icon(icon_name, "sm", "", "", "jce-quality-form-icon-svg", true);
		}
		return "";
	}

	function esc(value) {
		if (frappe.utils && frappe.utils.escape_html) {
			return frappe.utils.escape_html(value == null ? "" : String(value));
		}
		return $("<div>").text(value == null ? "" : String(value)).html();
	}

	function is_empty(value) {
		if (Array.isArray(value)) return value.length === 0;
		if (value === null || value === undefined) return true;
		if (typeof value === "string") return value.trim() === "";
		return false;
	}

	function field_host(field) {
		if (!field || !field.wrapper) return null;
		const wrapper = $(field.wrapper);
		let host = wrapper.find(".control-input-wrapper").first();
		if (host.length) return host;
		host = wrapper.find(".input-with-feedback").first();
		if (host.length) return host;
		host = wrapper.find(".control-input").first();
		return host.length ? host : null;
	}

	function ensure_styles() {
		if (document.getElementById("jce-quality-form-style")) return;
		const style = document.createElement("style");
		style.id = "jce-quality-form-style";
		style.textContent = `
			.jce-quality-form-scope {
				--jce-quality-info: #0071e3;
				--jce-quality-error: #c01f2f;
				--jce-quality-soft-error: #fff1f2;
			}
			.jce-quality-form-scope .jce-quality-field-host {
				position: relative;
			}
			.jce-quality-form-scope .jce-quality-field-host.jce-quality-field-has-icon .form-control,
			.jce-quality-form-scope .jce-quality-field-host.jce-quality-field-has-icon input,
			.jce-quality-form-scope .jce-quality-field-host.jce-quality-field-has-icon select,
			.jce-quality-form-scope .jce-quality-field-host.jce-quality-field-has-icon textarea {
				padding-right: 34px !important;
			}
			.jce-quality-form-scope .jce-quality-required-empty .form-control,
			.jce-quality-form-scope .jce-quality-required-empty input,
			.jce-quality-form-scope .jce-quality-required-empty select,
			.jce-quality-form-scope .jce-quality-required-empty textarea {
				border-color: var(--jce-quality-error) !important;
				background: var(--jce-quality-soft-error);
			}
			.jce-quality-form-scope .jce-quality-reqd:focus-within .control-input-wrapper,
			.jce-quality-form-scope .jce-quality-reqd:focus-within .input-with-feedback,
			.jce-quality-form-scope .jce-quality-reqd:focus-within .control-input {
				box-shadow: 0 0 0 2px rgba(0, 113, 227, 0.12);
				border-radius: 8px;
			}
			.jce-quality-form-scope .jce-quality-field-icon {
				position: absolute;
				right: 9px;
				top: 50%;
				transform: translateY(-50%);
				width: 16px;
				height: 16px;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				color: var(--jce-quality-error);
				pointer-events: none;
			}
			.jce-quality-form-scope .jce-quality-field-icon svg {
				width: 16px;
				height: 16px;
			}
		`;
		document.head.appendChild(style);
	}

	function clear_state(field) {
		const host = field_host(field);
		if (!host || !host.length) return;
		host
			.removeClass("jce-quality-field-host jce-quality-field-has-icon jce-quality-required-empty")
			.find(`.jce-quality-field-icon[data-fieldname="${field.df.fieldname}"]`)
			.remove();
	}

	function mark_required_empty(field) {
		const host = field_host(field);
		if (!host || !host.length) return;
		host.addClass("jce-quality-field-host jce-quality-field-has-icon jce-quality-required-empty");
		if (host.find(`.jce-quality-field-icon[data-fieldname="${field.df.fieldname}"]`).length) return;
		host.append(
			`<span class="jce-quality-field-icon" data-fieldname="${esc(field.df.fieldname)}" title="${esc(__("Required field is empty"))}">${icon_html("alert-circle")}</span>`
		);
	}

	function apply(frm) {
		if (!frm || !frm.wrapper || !frm.fields_dict) return;
		ensure_styles();
		$(frm.wrapper).addClass("jce-quality-form-scope");

		Object.keys(frm.fields_dict).forEach((fieldname) => {
			const field = frm.fields_dict[fieldname];
			if (!field || !field.df || !field.wrapper || SKIP_FIELD_TYPES.has(field.df.fieldtype)) return;
			$(field.wrapper).toggleClass("jce-quality-reqd", Boolean(field.df.reqd));
			clear_state(field);
			if (field.df.reqd && is_empty(frm.doc && frm.doc[fieldname])) {
				mark_required_empty(field);
			}
		});
	}

	root.form_style = {
		apply,
		ensure_styles,
	};
})();
