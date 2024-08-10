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

	let tokensValue = document.getElementById("tokensValue");
    get_lifetime_tokens(function(res) {
        tokensValue.innerText = res.input + " | " + res.output;
    });

	get_mode(function(mode) {
		update_colors(is_on(mode));
		update_mode_button_text(mode);
	});
}


function open_side_panel() {
    let isModeOn = new Promise(resolve => get_mode(mode => resolve(is_on(mode))));
    let isSidePanelClosed = new Promise(resolve => 
        chrome.runtime.sendMessage({ type: "is_sidepanel_open" }, response => resolve(!response.isOpen))
    );

    Promise.all([isModeOn, isSidePanelClosed])
        .then(([modeOn, panelClosed]) => {
            if (modeOn && panelClosed) {
				(async () => {
					let response = await chrome.runtime.sendMessage({ type: "open_side_panel" });
					response = await chrome.runtime.sendMessage({ type: "new_chat" });
					window.close();
				})();
            }
        });
}

function toggle_mode(callback) {
	chrome.storage.sync.get('mode', function(res) {
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
