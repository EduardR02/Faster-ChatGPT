import { ModeEnum, get_mode, set_mode, is_on, get_lifetime_tokens} from "./utils.js";

run_on_init();


function run_on_init() {
	let button = document.getElementById("buttonMode");
	button.addEventListener("click", function() {
		toggle_mode(function(mode) {
			update_colors(is_on(mode));
			update_mode_button_text(mode);
		});
		return true;
	});
	let button2 = document.getElementById("buttonSettings");
	button2.addEventListener("click", function() {
		chrome.runtime.openOptionsPage();
	});

	let button3 = document.getElementById("buttonChat");
	button3.addEventListener("click", open_side_panel);

	let historyButton = document.getElementById("buttonHistory");
	historyButton.addEventListener("click", open_history);

	let tokensValue = document.getElementById("tokensValue");
    get_lifetime_tokens(function(res) {
        tokensValue.innerText = res.input + " | " + res.output;
    });

	get_mode(function(mode) {
		update_colors(is_on(mode));
		update_mode_button_text(mode);
	});
}


async function open_side_panel() {
	// Check if mode is on
	const modeOn = await new Promise(resolve => get_mode(mode => resolve(is_on(mode))));
	if (!modeOn) {
		return;
	}

	// Check if panel is already open
	const { isOpen } = await chrome.runtime.sendMessage({ type: "is_sidepanel_open" });
	const wasClosed = !isOpen;

	// Open sidepanel via background (which has proper permissions)
	await chrome.runtime.sendMessage({ type: "open_side_panel" });
	
	// Send the new_chat message
	chrome.runtime.sendMessage({ type: "new_chat" }).catch(() => {});
	
	// Close popup if we opened the panel
	if (wasClosed) {
		self.close();
	}
}


function open_history() {
	chrome.tabs.create({url: chrome.runtime.getURL('src/html/history.html')});
}


function toggle_mode(callback) {
	chrome.storage.local.get('mode', function(res) {
		let new_mode = ModeEnum.Off;
		if (res.mode !== undefined) {
			// increment mode
			new_mode = (res.mode + 1) % Object.keys(ModeEnum).length;
		}
		callback(new_mode);
		set_mode(new_mode);
	});
}


function update_mode_button_text(mode) {
	let button = document.getElementById("buttonMode");
	if (mode === ModeEnum.InstantPromptMode) {
		button.innerHTML = "<span>" + "Instant Prompt Mode " + "</span>"
	}
	else if (mode === ModeEnum.PromptMode) {
		button.innerHTML = "<span>" + "Prompt Mode " + "</span>"
	}
	else {
		button.innerHTML = "<span>" + "Off " + "</span>"
	}
}


function update_colors(isOn) {
	const arr = document.getElementsByClassName('button');
	if (isOn) {
		Array.prototype.forEach.call(arr, el => {
			el.style.setProperty("--check-primary", "#61afef");
			el.style.setProperty("--check-secondary", "#ef596f");
		});
	}
	else {
		Array.prototype.forEach.call(arr, el => {
			el.style.setProperty("--check-primary", "#ef596f");
			el.style.setProperty("--check-secondary", "#61afef");
		});
	}
}
