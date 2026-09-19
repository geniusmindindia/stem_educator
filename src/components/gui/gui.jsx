import classNames from 'classnames';
import omit from 'lodash.omit';
import PropTypes from 'prop-types';
import React from 'react';
import {defineMessages, FormattedMessage, injectIntl, intlShape} from 'react-intl';
import {connect} from 'react-redux';
import MediaQuery from 'react-responsive';
import {Tab, Tabs, TabList, TabPanel} from 'react-tabs';
import tabStyles from 'react-tabs/style/react-tabs.css';
import VM from 'scratch-vm';

import Blocks from '../../containers/blocks.jsx';
import CostumeTab from '../../containers/costume-tab.jsx';
import TargetPane from '../../containers/target-pane.jsx';
import SoundTab from '../../containers/sound-tab.jsx';
import StageWrapper from '../../containers/stage-wrapper.jsx';
import Loader from '../loader/loader.jsx';
import Box from '../box/box.jsx';
import MenuBar from '../menu-bar/menu-bar.jsx';
import CostumeLibrary from '../../containers/costume-library.jsx';
import BackdropLibrary from '../../containers/backdrop-library.jsx';
import Watermark from '../../containers/watermark.jsx';

import Backpack from '../../containers/backpack.jsx';
import BrowserModal from '../browser-modal/browser-modal.jsx';
import TipsLibrary from '../../containers/tips-library.jsx';
import Cards from '../../containers/cards.jsx';
import Alerts from '../../containers/alerts.jsx';
import DragLayer from '../../containers/drag-layer.jsx';
import AuthModal from '../../containers/auth-modal.jsx';
import ConnectionModal from '../../containers/connection-modal.jsx';
import TelemetryModal from '../telemetry-modal/telemetry-modal.jsx';
import TWUsernameModal from '../../containers/tw-username-modal.jsx';
import TWSettingsModal from '../../containers/tw-settings-modal.jsx';
import TWSecurityManager from '../../containers/tw-security-manager.jsx';
import TWCustomExtensionModal from '../../containers/tw-custom-extension-modal.jsx';
import TWRestorePointManager from '../../containers/tw-restore-point-manager.jsx';
import TWFontsModal from '../../containers/tw-fonts-modal.jsx';
import TWUnknownPlatformModal from '../../containers/tw-unknown-platform-modal.jsx';
import TWInvalidProjectModal from '../../containers/tw-invalid-project-modal.jsx';
import TWWindChimeSubmitter from '../../containers/tw-windchime-submitter.jsx';

import {STAGE_SIZE_MODES, FIXED_WIDTH, UNCONSTRAINED_NON_STAGE_WIDTH} from '../../lib/layout-constants';
import {resolveStageSize} from '../../lib/screen-utils';
import {getHwApiBase} from '../../lib/tw-hardware-agent';
import {flashAtmega328p} from '../../lib/stk500-flasher';
import {openWebSerialConnection, activateGlobalWebSerialConnection} from '../../lib/web-serial-connection';
import {Theme} from '../../lib/themes';

import {isRendererSupported, isBrowserSupported} from '../../lib/tw-environment-support-prober';

import styles from './gui.css';
import addExtensionIcon from './icon--extensions.svg';
import codeIcon from '!../../lib/tw-recolor/build!./icon--code.svg';
import costumesIcon from '!../../lib/tw-recolor/build!./icon--costumes.svg';
import soundsIcon from '!../../lib/tw-recolor/build!./icon--sounds.svg';

const messages = defineMessages({
    addExtension: {
        id: 'gui.gui.addExtension',
        description: 'Button to add an extension in the target pane',
        defaultMessage: 'Add Extension'
    }
});

const getFullscreenBackgroundColor = () => {
    const params = new URLSearchParams(location.search);
    if (params.has('fullscreen-background')) {
        return params.get('fullscreen-background');
    }
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return '#111';
    }
    return 'white';
};

const fullscreenBackgroundColor = getFullscreenBackgroundColor();

const CPP_TEMPLATE = `//This c++ code is generated

void setup() {
	//put your setup code here, to run once:
	
	
}

void loop() {
	//put your main code here, to run repeatedly:
	
	
}
`;

const BOARD_PREFIX = {
    arduino_uno: 'arduinoUno',
    arduino_nano: 'arduinoNano',
    arduino_mega: 'arduinoMega',
    esp32: 'esp32'
};

const BOARD_FQBN = {
    arduino_uno: 'arduino:avr:uno',
    arduino_nano: 'arduino:avr:nano',
    arduino_mega: 'arduino:avr:mega:cpu=atmega2560',
    esp32: 'esp32:esp32:esp32'
};

function convertBlocksToCpp (vm, board) {
    if (!vm || !vm.runtime) return CPP_TEMPLATE;

    const prefix = board ? (BOARD_PREFIX[board.id] || 'arduinoUno') : 'arduinoUno';

    const allBlocks = {};
    for (const target of vm.runtime.targets) {
        if (target.blocks && target.blocks._blocks) {
            Object.assign(allBlocks, target.blocks._blocks);
        }
    }

    // Extract field value from either runtime object {name, value} or serialized array [value, id]
    function fv (field) {
        if (!field) return null;
        if (Array.isArray(field)) return field[0];
        return field.value !== undefined ? field.value : null;
    }

    // Get the shadow/input block id from either runtime object {block, shadow} or serialized array [type, blockId, shadowId]
    function inputBlockId (inp) {
        if (!inp) return null;
        if (Array.isArray(inp)) return inp[1] || inp[2] || null;
        return inp.block || inp.shadow || null;
    }

    // DIAGNOSTIC: dump a block's raw structure
    function diagBlock (block) {
        try {
            var fieldsStr = JSON.stringify(block.fields);
            var inputsObj = {};
            for (var k in block.inputs) {
                var inp = block.inputs[k];
                var bid2 = inputBlockId(inp);
                inputsObj[k] = {raw: JSON.stringify(inp), shadowId: bid2, shadowFields: bid2 && allBlocks[bid2] ? JSON.stringify(allBlocks[bid2].fields) : 'NOT_FOUND'};
            }
            return '// BLOCK ' + block.opcode + ' fields=' + fieldsStr + ' inputs=' + JSON.stringify(inputsObj);
        } catch (_) { return '// diag error'; }
    }

    function getArgValue (block, argName) {
        // 1. Check if the value is directly in the block's own fields (for non-menu args)
        if (block.fields && block.fields[argName] !== undefined) {
            const v = fv(block.fields[argName]);
            if (v !== null) return String(v);
        }
        // 2. Follow the input to the shadow/reporter block
        if (block.inputs && block.inputs[argName]) {
            const bid = inputBlockId(block.inputs[argName]);
            if (bid && allBlocks[bid]) {
                return blockToExpr(allBlocks[bid]);
            }
        }
        return '0';
    }

    function blockToExpr (b) {
        if (!b) return '0';
        const op = b.opcode;

        // Numeric literal shadow blocks
        if (['math_number','math_whole_number','math_positive_number','math_integer','math_angle'].includes(op)) {
            const v = fv(b.fields && b.fields.NUM);
            return v !== null ? String(v) : '0';
        }
        // Text literal
        if (op === 'text') {
            const v = fv(b.fields && b.fields.TEXT);
            return '"' + (v !== null ? v : '') + '"';
        }

        // Board reporter blocks
        if (op === prefix + '_digitalRead') return 'digitalRead(' + getArgValue(b, 'PIN') + ')';
        if (op === prefix + '_analogRead') return 'analogRead(' + getArgValue(b, 'PIN') + ')';

        // Operator blocks
        if (op === 'operator_equals') return '(' + getArgValue(b, 'OPERAND1') + ' == ' + getArgValue(b, 'OPERAND2') + ')';
        if (op === 'operator_gt') return '(' + getArgValue(b, 'OPERAND1') + ' > ' + getArgValue(b, 'OPERAND2') + ')';
        if (op === 'operator_lt') return '(' + getArgValue(b, 'OPERAND1') + ' < ' + getArgValue(b, 'OPERAND2') + ')';
        if (op === 'operator_and') return '(' + getArgValue(b, 'OPERAND1') + ' && ' + getArgValue(b, 'OPERAND2') + ')';
        if (op === 'operator_or') return '(' + getArgValue(b, 'OPERAND1') + ' || ' + getArgValue(b, 'OPERAND2') + ')';
        if (op === 'operator_not') return '!(' + getArgValue(b, 'OPERAND') + ')';
        if (op === 'operator_add') return '(' + getArgValue(b, 'NUM1') + ' + ' + getArgValue(b, 'NUM2') + ')';
        if (op === 'operator_subtract') return '(' + getArgValue(b, 'NUM1') + ' - ' + getArgValue(b, 'NUM2') + ')';
        if (op === 'operator_multiply') return '(' + getArgValue(b, 'NUM1') + ' * ' + getArgValue(b, 'NUM2') + ')';
        if (op === 'operator_divide') return '(' + getArgValue(b, 'NUM1') + ' / ' + getArgValue(b, 'NUM2') + ')';

        // Menu shadow blocks — opcode is like "arduinoUno_menu_PIN_MENU"
        // The field key matches the part after "_menu_"
        if (op && op.includes('_menu_') && b.fields) {
            const menuName = op.split('_menu_').slice(1).join('_menu_'); // e.g. "PIN_MENU"
            if (b.fields[menuName] !== undefined) {
                const v = fv(b.fields[menuName]);
                if (v !== null) return String(v);
            }
            // Fallback: grab the first field value regardless of key name
            const keys = Object.keys(b.fields);
            if (keys.length > 0) {
                const v = fv(b.fields[keys[0]]);
                if (v !== null) return String(v);
            }
        }

        // Generic fallback: any single-field shadow block
        if (b.fields) {
            const keys = Object.keys(b.fields);
            if (keys.length > 0) {
                const v = fv(b.fields[keys[0]]);
                if (v !== null) return String(v);
            }
        }
        return '0';
    }

    function getChain (startId) {
        const chain = [];
        let id = startId;
        const visited = new Set();
        while (id && allBlocks[id] && !visited.has(id)) {
            visited.add(id);
            chain.push(allBlocks[id]);
            id = allBlocks[id].next;
        }
        return chain;
    }

    function substackToLines (block, substackName, indent) {
        if (!block.inputs || !block.inputs[substackName]) return [];
        const sid = inputBlockId(block.inputs[substackName]);
        if (!sid) return [];
        const lines = [];
        for (const b of getChain(sid)) lines.push.apply(lines, blockToLines(b, indent));
        return lines;
    }

    var NOTE_FREQ = {C2:65,D2:73,E2:82,F2:87,G2:98,A2:110,B2:123,C3:131,D3:147,E3:165,F3:175,G3:196,A3:220,B3:247,C4:262,D4:294,E4:330,F4:349,G4:392,A4:440,B4:494,C5:523,D5:587,E5:659,F5:698,G5:784,A5:880,B5:988};
    var BEAT_MS = {Whole:1000,Half:500,Quarter:250,Eighth:125,'1/16':63};

    function blockToLines (block, indent) {
        const pad = new Array(indent + 1).join('\t');
        const op = block.opcode;

        if (op === prefix + '_setPinMode') {
            return [pad + 'pinMode(' + getArgValue(block, 'PIN') + ', ' + getArgValue(block, 'MODE') + ');'];
        }
        if (op === prefix + '_digitalWrite') {
            var val = getArgValue(block, 'VALUE');
            var cppVal = (val === '1' || val.toUpperCase() === 'HIGH' || val.toUpperCase() === 'TRUE') ? 'true' : 'false';
            return [pad + 'digitalWrite(' + getArgValue(block, 'PIN') + ', ' + cppVal + ');'];
        }
        if (op === prefix + '_analogWrite') {
            return [pad + 'analogWrite(' + getArgValue(block, 'PIN') + ', ' + getArgValue(block, 'VALUE') + ');'];
        }
        if (op === prefix + '_setServoAngle') {
            var sPin = getArgValue(block, 'PIN');
            // servoVarLookup resolves the same (possibly disambiguated) name
            // that was declared for this exact pin expression.
            var sVar = (typeof servoVarLookup === 'function') ? servoVarLookup(sPin) : servoVar(sPin);
            return [pad + sVar + '.write(' + getArgValue(block, 'ANGLE') + ');'];
        }
        if (op === prefix + '_playTone') {
            var tPin = getArgValue(block, 'PIN');
            var note = getArgValue(block, 'NOTE');
            var beat = getArgValue(block, 'BEAT');
            var freq = NOTE_FREQ[note] || 440;
            var dur = BEAT_MS[beat] || 500;
            return [
                pad + 'tone(' + tPin + ',' + freq + ',' + dur + ');',
                pad + 'delay(' + dur + ');'
            ];
        }
        if (op === prefix + '_stopTone') {
            return [pad + 'noTone(' + getArgValue(block, 'PIN') + ');'];
        }
        if (op === 'control_wait') {
            return [pad + 'delay((int)(' + getArgValue(block, 'DURATION') + ' * 1000));'];
        }
        if (op === 'control_forever') {
            return [pad + 'while (true) {'].concat(substackToLines(block, 'SUBSTACK', indent + 1)).concat([pad + '}']);
        }
        if (op === 'control_repeat') {
            return [pad + 'for (int _i = 0; _i < ' + getArgValue(block, 'TIMES') + '; _i++) {']
                .concat(substackToLines(block, 'SUBSTACK', indent + 1))
                .concat([pad + '}']);
        }
        if (op === 'control_if') {
            return [pad + 'if (' + getArgValue(block, 'CONDITION') + ') {']
                .concat(substackToLines(block, 'SUBSTACK', indent + 1))
                .concat([pad + '}']);
        }
        if (op === 'control_if_else') {
            return [pad + 'if (' + getArgValue(block, 'CONDITION') + ') {']
                .concat(substackToLines(block, 'SUBSTACK', indent + 1))
                .concat([pad + '} else {'])
                .concat(substackToLines(block, 'SUBSTACK2', indent + 1))
                .concat([pad + '}']);
        }
        if (op === 'control_wait_until') {
            return [pad + 'while (!(' + getArgValue(block, 'CONDITION') + ')) { delay(10); }'];
        }
        if (op === 'control_repeat_until') {
            return [pad + 'while (!(' + getArgValue(block, 'CONDITION') + ')) {']
                .concat(substackToLines(block, 'SUBSTACK', indent + 1))
                .concat([pad + '}']);
        }
        return [];
    }

    // Servo object names must be valid C++ identifiers. The PIN slot can hold
    // a nested reporter (e.g. digitalRead(7)) — using the raw expression as
    // an identifier produced `Servo servo_digitalRead(7);` (compile error).
    // Sanitize to identifier chars; attach() still gets the raw expression
    // so even computed pins compile and work at runtime.
    function servoVar (pinExpr) {
        var id = String(pinExpr === undefined || pinExpr === null ? '' : pinExpr).replace(/[^A-Za-z0-9_]/g, '');
        // 'servo_' prefix already guarantees a letter start, so digits are fine.
        return 'servo_' + (id || 'x');
    }

    // Detect servo pins for declarations (map sanitized var name -> raw pin expr)
    const servoPins = new Map();
    for (const b of Object.values(allBlocks)) {
        if (b.opcode === prefix + '_setServoAngle') {
            const pin = getArgValue(b, 'PIN');
            if (pin && pin !== '0') {
                var v = servoVar(pin);
                if (servoPins.has(v) && servoPins.get(v) !== pin) {
                    // Collision between different exprs sanitizing alike — disambiguate
                    var n = 2;
                    while (servoPins.has(v + '_' + n) && servoPins.get(v + '_' + n) !== pin) n++;
                    v = v + '_' + n;
                }
                // Re-resolve var for this block usage consistency: store per raw expr
                if (!servoPins.has(v)) servoPins.set(v, pin);
            }
        }
    }
    // Helper used above in blockToLines must resolve same names: rebuild lookup
    function servoVarLookup (pinExpr) {
        var lookupName = servoVar(pinExpr);
        if (servoPins.get(lookupName) === pinExpr) return lookupName;
        for (const entry of servoPins.entries()) {
            if (entry[1] === pinExpr) return entry[0];
        }
        return lookupName;
    }

    // Collect pins that need implicit pinMode.
    // Only plain pins (number or identifier) get pinMode — computed expressions
    // like digitalRead(7) are evaluated at runtime and must not become
    // `pinMode(digitalRead(7), OUTPUT);`.
    function isPlainPin (p) {
        return typeof p === 'string' && (/^\d+$/.test(p) || /^[A-Za-z_][A-Za-z0-9_]*$/.test(p) || /^A\d+$/i.test(p));
    }
    const outputPins = new Set();
    const inputPins = new Set();
    const explicitPins = new Set();
    for (const b of Object.values(allBlocks)) {
        if (b.shadow) continue;
        const bop = b.opcode;
        if (bop === prefix + '_setPinMode') {
            explicitPins.add(getArgValue(b, 'PIN'));
        } else if (bop === prefix + '_digitalWrite' || bop === prefix + '_analogWrite' || bop === prefix + '_playTone' || bop === prefix + '_setServoAngle') {
            const p = getArgValue(b, 'PIN');
            if (p && p !== '0' && isPlainPin(p)) outputPins.add(p);
        } else if (bop === prefix + '_digitalRead' || bop === prefix + '_analogRead') {
            const p = getArgValue(b, 'PIN');
            if (p && p !== '0' && isPlainPin(p)) inputPins.add(p);
        }
    }
    const implicitPinLines = [];
    outputPins.forEach(function (p) {
        if (!explicitPins.has(p)) implicitPinLines.push('\tpinMode(' + p + ', OUTPUT);');
    });
    inputPins.forEach(function (p) {
        if (!explicitPins.has(p) && !outputPins.has(p)) implicitPinLines.push('\tpinMode(' + p + ', INPUT);');
    });

    // Convert ALL top-level block chains — no hat block required.
    // Hat blocks (whenStarted, green flag) are skipped themselves; their children are converted.
    // Non-hat top-level blocks are converted directly.
    const hatOpcodes = new Set([prefix + '_whenStarted', 'event_whenflagclicked']);

    const topLevelEntries = Object.entries(allBlocks).filter(
        function (entry) { return entry[1].parent === null && !entry[1].shadow; }
    );

    if (topLevelEntries.length === 0) return CPP_TEMPLATE;

    const setupLines = [];
    const loopLines = [];

    for (var tli = 0; tli < topLevelEntries.length; tli++) {
        var tlId = topLevelEntries[tli][0];
        var tlBlock = topLevelEntries[tli][1];
        var chainStartId = hatOpcodes.has(tlBlock.opcode) ? tlBlock.next : tlId;
        if (!chainStartId) continue;
        for (const block of getChain(chainStartId)) {
            if (block.opcode === 'control_forever') {
                loopLines.push.apply(loopLines, substackToLines(block, 'SUBSTACK', 1));
            } else {
                setupLines.push.apply(setupLines, blockToLines(block, 1));
            }
        }
    }

    var code = '//This c++ code is generated\n\n';
    if (servoPins.size > 0) {
        code += '#include <Servo.h>\n\n';
        servoPins.forEach(function (pinExpr, varName) { code += 'Servo ' + varName + ';\n'; });
        code += '\n';
    }
    code += 'void setup() {\n';
    // Attach each servo to its pin (raw expression evaluated at runtime).
    // Previously missing entirely, so servos compiled but never moved.
    var servoAttachLines = [];
    servoPins.forEach(function (pinExpr, varName) { servoAttachLines.push('\t' + varName + '.attach(' + pinExpr + ');'); });
    var allSetup = implicitPinLines.concat(servoAttachLines)
        .concat((implicitPinLines.length > 0 || servoAttachLines.length > 0) && setupLines.length > 0 ? [''] : [])
        .concat(setupLines);
    code += allSetup.length > 0 ? (allSetup.join('\n') + '\n') : '\t//put your setup code here, to run once:\n\t\n\t\n';
    code += '}\n\nvoid loop() {\n';
    code += loopLines.length > 0 ? (loopLines.join('\n') + '\n') : '\t//put your main code here, to run repeatedly:\n\t\n\t\n';
    code += '}\n';
    return code;
}

const GUIComponent = props => {
    const [hwUploadMode, setHwUploadMode] = React.useState(false);
    const [hwUploadBoard, setHwUploadBoard] = React.useState(null);
    const [hwUploadCode, setHwUploadCode] = React.useState(CPP_TEMPLATE);
    const [hwBottomTab, setHwBottomTab] = React.useState(0);
    const [hwLogLines, setHwLogLines] = React.useState([]);
    const [hwCodeLocked, setHwCodeLocked] = React.useState(true);
    const hwLineNumRef = React.useRef(null);
    // Guards the Firmware/Upload buttons against double-clicks: concurrent
    // flashes fight over the COM port and ALL fail ("unable to open port").
    const hwFlashBusyRef = React.useRef(false);

    const vmRef = React.useRef(props.vm);
    vmRef.current = props.vm;

    React.useEffect(() => {
        const handler = e => {
            if (e.detail.mode === 'upload') {
                setHwUploadMode(true);
                setHwUploadBoard(e.detail.board);
                setHwUploadCode(convertBlocksToCpp(vmRef.current, e.detail.board));
            } else {
                setHwUploadMode(false);
            }
        };
        window.addEventListener('hwModeChange', handler);
        return () => window.removeEventListener('hwModeChange', handler);
    }, []);

    const {
        accountNavOpen,
        activeTabIndex,
        alertsVisible,
        authorId,
        authorThumbnailUrl,
        authorUsername,
        basePath,
        backdropLibraryVisible,
        backpackHost,
        backpackVisible,
        blocksId,
        blocksTabVisible,
        cardsVisible,
        canChangeLanguage,
        canChangeTheme,
        canCreateNew,
        canEditTitle,
        canManageFiles,
        canRemix,
        canSave,
        canCreateCopy,
        canShare,
        canUseCloud,
        children,
        connectionModalVisible,
        costumeLibraryVisible,
        onRequestCloseAuthModal,
        authModalVisible,
        costumesTabVisible,
        customStageSize,
        enableCommunity,
        intl,
        isCreating,
        isEmbedded,
        isFullScreen,
        isPlayerOnly,
        isRtl,
        isShared,
        isWindowFullScreen,
        isTelemetryEnabled,
        isTotallyNormal,
        loading,
        logo,
        renderLogin,
        onClickAbout,
        onClickAccountNav,
        onCloseAccountNav,
        onClickAddonSettings,
        onClickDesktopSettings,
        onClickNewWindow,
        onClickPackager,
        onLogOut,
        onOpenRegistration,
        onToggleLoginOpen,
        onActivateCostumesTab,
        onActivateSoundsTab,
        onActivateTab,
        onClickLogo,
        onExtensionButtonClick,
        onOpenCustomExtensionModal,
        onProjectTelemetryEvent,
        onRequestCloseBackdropLibrary,
        onRequestCloseCostumeLibrary,
        onRequestCloseTelemetryModal,
        onSeeCommunity,
        onShare,
        onShowPrivacyPolicy,
        onStartSelectingFileUpload,
        onTelemetryModalCancel,
        onTelemetryModalOptIn,
        onTelemetryModalOptOut,
        securityManager,
        showComingSoon,
        showOpenFilePicker,
        showSaveFilePicker,
        soundsTabVisible,
        stageSizeMode,
        targetIsStage,
        telemetryModalVisible,
        theme,
        tipsLibraryVisible,
        usernameModalVisible,
        settingsModalVisible,
        customExtensionModalVisible,
        fontsModalVisible,
        unknownPlatformModalVisible,
        invalidProjectModalVisible,
        vm,
        ...componentProps
    } = omit(props, 'dispatch');
    if (children) {
        return <Box {...componentProps}>{children}</Box>;
    }

    const tabClassNames = {
        tabs: styles.tabs,
        tab: classNames(tabStyles.reactTabsTab, styles.tab),
        tabList: classNames(tabStyles.reactTabsTabList, styles.tabList),
        tabPanel: classNames(tabStyles.reactTabsTabPanel, styles.tabPanel),
        tabPanelSelected: classNames(tabStyles.reactTabsTabPanelSelected, styles.isSelected),
        tabSelected: classNames(tabStyles.reactTabsTabSelected, styles.isSelected)
    };

    const unconstrainedWidth = (
        UNCONSTRAINED_NON_STAGE_WIDTH +
        FIXED_WIDTH +
        Math.max(0, customStageSize.width - FIXED_WIDTH)
    );
    return (<MediaQuery minWidth={unconstrainedWidth}>{isUnconstrained => {
        const stageSize = resolveStageSize(stageSizeMode, isUnconstrained);

        const alwaysEnabledModals = (
            <React.Fragment>
                <TWSecurityManager securityManager={securityManager} />
                <TWRestorePointManager />
                <TWWindChimeSubmitter isEmbedded={isEmbedded} />
                {usernameModalVisible && <TWUsernameModal />}
                {settingsModalVisible && <TWSettingsModal />}
                {authModalVisible && <AuthModal />}
                {customExtensionModalVisible && <TWCustomExtensionModal />}
                {fontsModalVisible && <TWFontsModal />}
                {unknownPlatformModalVisible && <TWUnknownPlatformModal />}
                {invalidProjectModalVisible && <TWInvalidProjectModal />}
            </React.Fragment>
        );

        return isPlayerOnly ? (
            <React.Fragment>
                {/* TW: When the window is fullscreen, use an element to display the background color */}
                {/* The default color for transparency is inconsistent between browsers and there isn't an existing */}
                {/* element for us to style that fills the entire screen. */}
                {isWindowFullScreen ? (
                    <div
                        className={styles.fullscreenBackground}
                        style={{
                            backgroundColor: fullscreenBackgroundColor
                        }}
                    />
                ) : null}
                <StageWrapper
                    isFullScreen={isFullScreen}
                    isEmbedded={isEmbedded}
                    isRendererSupported={isRendererSupported()}
                    isRtl={isRtl}
                    loading={loading}
                    stageSize={STAGE_SIZE_MODES.full}
                    vm={vm}
                >
                    {alertsVisible ? (
                        <Alerts className={styles.alertsContainer} />
                    ) : null}
                </StageWrapper>
                {alwaysEnabledModals}
            </React.Fragment>
        ) : (
            <Box
                className={styles.pageWrapper}
                dir={isRtl ? 'rtl' : 'ltr'}
                style={{
                    minWidth: (hwUploadMode ? 1524 : 1024) + Math.max(0, customStageSize.width - 480),
                    minHeight: 640 + Math.max(0, customStageSize.height - 360)
                }}
                {...componentProps}
            >
                {alwaysEnabledModals}
                {telemetryModalVisible ? (
                    <TelemetryModal
                        isRtl={isRtl}
                        isTelemetryEnabled={isTelemetryEnabled}
                        onCancel={onTelemetryModalCancel}
                        onOptIn={onTelemetryModalOptIn}
                        onOptOut={onTelemetryModalOptOut}
                        onRequestClose={onRequestCloseTelemetryModal}
                        onShowPrivacyPolicy={onShowPrivacyPolicy}
                    />
                ) : null}
                {loading ? (
                    <Loader isFullScreen />
                ) : null}
                {isCreating ? (
                    <Loader
                        isFullScreen
                        messageId="gui.loader.creating"
                    />
                ) : null}
                {isBrowserSupported() ? null : (
                    <BrowserModal
                        isRtl={isRtl}
                        onClickDesktopSettings={onClickDesktopSettings}
                    />
                )}
                {tipsLibraryVisible ? (
                    <TipsLibrary />
                ) : null}
                {cardsVisible ? (
                    <Cards />
                ) : null}
                {alertsVisible ? (
                    <Alerts className={styles.alertsContainer} />
                ) : null}
                {connectionModalVisible ? (
                    <ConnectionModal
                        vm={vm}
                    />
                ) : null}
                {costumeLibraryVisible ? (
                    <CostumeLibrary
                        vm={vm}
                        onRequestClose={onRequestCloseCostumeLibrary}
                    />
                ) : null}
                {backdropLibraryVisible ? (
                    <BackdropLibrary
                        vm={vm}
                        onRequestClose={onRequestCloseBackdropLibrary}
                    />
                ) : null}
                <MenuBar
                    accountNavOpen={accountNavOpen}
                    authorId={authorId}
                    authorThumbnailUrl={authorThumbnailUrl}
                    authorUsername={authorUsername}
                    canChangeLanguage={canChangeLanguage}
                    canChangeTheme={canChangeTheme}
                    canCreateCopy={canCreateCopy}
                    canCreateNew={canCreateNew}
                    canEditTitle={canEditTitle}
                    canManageFiles={canManageFiles}
                    canRemix={canRemix}
                    canSave={canSave}
                    canShare={canShare}
                    className={styles.menuBarPosition}
                    enableCommunity={enableCommunity}
                    isShared={isShared}
                    isTotallyNormal={isTotallyNormal}
                    logo={logo}
                    renderLogin={renderLogin}
                    showComingSoon={showComingSoon}
                    showOpenFilePicker={showOpenFilePicker}
                    showSaveFilePicker={showSaveFilePicker}
                    onClickAbout={onClickAbout}
                    onClickAccountNav={onClickAccountNav}
                    onClickAddonSettings={onClickAddonSettings}
                    onClickDesktopSettings={onClickDesktopSettings}
                    onClickNewWindow={onClickNewWindow}
                    onClickPackager={onClickPackager}
                    onClickLogo={onClickLogo}
                    onCloseAccountNav={onCloseAccountNav}
                    onLogOut={onLogOut}
                    onOpenRegistration={onOpenRegistration}
                    onProjectTelemetryEvent={onProjectTelemetryEvent}
                    onSeeCommunity={onSeeCommunity}
                    onShare={onShare}
                    onStartSelectingFileUpload={onStartSelectingFileUpload}
                    onToggleLoginOpen={onToggleLoginOpen}
                />
                <Box className={styles.bodyWrapper}>
                    <Box className={styles.flexWrapper}>
                        <Box className={styles.editorWrapper}>
                            <Tabs
                                forceRenderTabPanel
                                className={tabClassNames.tabs}
                                selectedIndex={activeTabIndex}
                                selectedTabClassName={tabClassNames.tabSelected}
                                selectedTabPanelClassName={tabClassNames.tabPanelSelected}
                                onSelect={onActivateTab}
                            >
                                <TabList className={tabClassNames.tabList}>
                                    <Tab className={tabClassNames.tab}>
                                        <img
                                            draggable={false}
                                            src={codeIcon()}
                                        />
                                        <FormattedMessage
                                            defaultMessage="Blocks"
                                            description="Button to get to the blocks panel"
                                            id="gui.gui.blocksTab"
                                        />
                                    </Tab>
                                    <Tab
                                        className={tabClassNames.tab}
                                        onClick={onActivateCostumesTab}
                                    >
                                        <img
                                            draggable={false}
                                            src={costumesIcon()}
                                        />
                                        {targetIsStage ? (
                                            <FormattedMessage
                                                defaultMessage="Backdrops"
                                                description="Button to get to the backdrops panel"
                                                id="gui.gui.backdropsTab"
                                            />
                                        ) : (
                                            <FormattedMessage
                                                defaultMessage="Costumes"
                                                description="Button to get to the costumes panel"
                                                id="gui.gui.costumesTab"
                                            />
                                        )}
                                    </Tab>
                                    <Tab
                                        className={tabClassNames.tab}
                                        onClick={onActivateSoundsTab}
                                    >
                                        <img
                                            draggable={false}
                                            src={soundsIcon()}
                                        />
                                        <FormattedMessage
                                            defaultMessage="Sounds"
                                            description="Button to get to the sounds panel"
                                            id="gui.gui.soundsTab"
                                        />
                                    </Tab>
                                </TabList>
                                <TabPanel className={tabClassNames.tabPanel}>
                                    <Box className={styles.blocksWrapper}>
                                        <Blocks
                                            key={`${blocksId}/${theme.id}`}
                                            canUseCloud={canUseCloud}
                                            grow={1}
                                            isVisible={blocksTabVisible}
                                            options={{
                                                media: `${basePath}static/${theme.getBlocksMediaFolder()}/`
                                            }}
                                            stageSize={stageSize}
                                            onOpenCustomExtensionModal={onOpenCustomExtensionModal}
                                            theme={theme}
                                            vm={vm}
                                        />
                                    </Box>
                                    <Box className={styles.extensionButtonContainer}>
                                        <button
                                            className={styles.extensionButton}
                                            title={intl.formatMessage(messages.addExtension)}
                                            onClick={onExtensionButtonClick}
                                        >
                                            <img
                                                className={styles.extensionButtonIcon}
                                                draggable={false}
                                                src={addExtensionIcon}
                                            />
                                        </button>
                                    </Box>
                                    <Box className={styles.watermark}>
                                        <Watermark />
                                    </Box>
                                </TabPanel>
                                <TabPanel className={tabClassNames.tabPanel}>
                                    {costumesTabVisible ? <CostumeTab
                                        vm={vm}
                                    /> : null}
                                </TabPanel>
                                <TabPanel className={tabClassNames.tabPanel}>
                                    {soundsTabVisible ? <SoundTab vm={vm} /> : null}
                                </TabPanel>
                            </Tabs>
                            {backpackVisible ? (
                                <Backpack host={backpackHost} />
                            ) : null}
                        </Box>

                        <Box
                            className={classNames(styles.stageAndTargetWrapper, hwUploadMode ? null : styles[stageSize])}
                            style={hwUploadMode ? {flex: '0 0 520px', paddingLeft: 0, paddingRight: 0} : null}
                        >
                            {hwUploadMode ? (
                                <div className={styles.hwCodePanel}>
                                    <div className={styles.hwCodePanelHeader}>
                                        <button className={styles.hwCodeIconBtn} title="Code view">{'</>'}</button>
                                        <button
                                            className={styles.hwCodeIconBtn}
                                            title="Back to Stage"
                                            // eslint-disable-next-line react/jsx-no-bind
                                            onClick={() => window.dispatchEvent(new CustomEvent('hwModeChange', {detail: {mode: 'stage'}}))}
                                        >{'×'}</button>
                                        <button
                                            className={classNames(styles.hwCodeIconBtn, hwCodeLocked ? styles.hwCodeLockActive : null)}
                                            title={hwCodeLocked ? 'Unlock code (allow editing)' : 'Lock code (read only)'}
                                            // eslint-disable-next-line react/jsx-no-bind
                                            onClick={() => setHwCodeLocked(!hwCodeLocked)}
                                        >{hwCodeLocked ? '🔒' : '🔓'}</button>
                                        <div className={styles.hwCodePanelSpacer} />
                                        <div className={styles.hwCodePanelDivider} />
                                        <button
                                            className={styles.hwClearBtn}
                                            title="Clear Log"
                                            // eslint-disable-next-line react/jsx-no-bind
                                            onClick={() => setHwLogLines([])}
                                        >
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <polyline points="3 6 5 6 21 6" />
                                                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
                                                <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                                                <line x1="10" y1="11" x2="10" y2="17" />
                                                <line x1="14" y1="11" x2="14" y2="17" />
                                            </svg>
                                        </button>
                                        <button
                                            className={styles.hwClearBtn}
                                            title="Clear Code"
                                            // eslint-disable-next-line react/jsx-no-bind
                                            onClick={() => setHwUploadCode(CPP_TEMPLATE)}
                                        >
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <polyline points="3 6 5 6 21 6" />
                                                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
                                                <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                                                <line x1="10" y1="11" x2="10" y2="17" />
                                                <line x1="14" y1="11" x2="14" y2="17" />
                                            </svg>
                                        </button>
                                        <button
                                            className={styles.hwUploadCodeBtn}
                                            title="Upload Firmware: Flash stage firmware for live serial block control"
                                            // eslint-disable-next-line react/jsx-no-bind
                                            onClick={async () => {
                                                const ts = new Date().toLocaleTimeString();
                                                if (hwFlashBusyRef.current) {
                                                    setHwLogLines(prev => prev.concat('[' + ts + '] Upload already running - please wait...'));
                                                    return;
                                                }
                                                hwFlashBusyRef.current = true;
                                                setHwLogLines(prev => prev.concat('[' + ts + '] Starting firmware upload...'));
                                                setHwBottomTab(0);

                                                // Phase 2: flash the prebuilt stage_firmware .hex directly from
                                                // the browser over Web Serial - simpler than Upload Code since
                                                // there's no compile step, just an already-built hex file (plain
                                                // text data, so even the cloud backend can serve it with zero
                                                // toolchain). Only Uno/Nano for now. Unlike Upload Code, this
                                                // needs to reconnect afterward for live control, since
                                                // stage_firmware IS the live-control interpreter.
                                                {
                                                    const boardIdForFlash = hwUploadBoard ? hwUploadBoard.id : 'arduino_uno';
                                                    const isAtmega328pForFlash = boardIdForFlash === 'arduino_uno' || boardIdForFlash === 'arduino_nano';
                                                    const webSerialPortForFlash = window.__hardwareConnection && window.__hardwareConnection.webSerialPort;
                                                    if (isAtmega328pForFlash && webSerialPortForFlash) {
                                                        try {
                                                            if (window.__hardwareConnection.disconnect) {
                                                                await window.__hardwareConnection.disconnect();
                                                            }
                                                            const apiBase = await getHwApiBase();
                                                            setHwLogLines(prev => prev.concat('[' + new Date().toLocaleTimeString() + '] Fetching stage firmware...'));
                                                            const r = await fetch(apiBase + '/firmware/stage-hex?boardType=' + boardIdForFlash);
                                                            const data = await r.json();
                                                            if (!data.success) throw new Error(data.error || 'Could not fetch stage firmware');
                                                            setHwLogLines(prev => prev.concat('[' + new Date().toLocaleTimeString() + '] Flashing directly over Web Serial (no agent)...'));
                                                            await flashAtmega328p(webSerialPortForFlash, data.hex, (info) => {
                                                                setHwLogLines(prev => {
                                                                    const line = '[' + new Date().toLocaleTimeString() + '] ' + info.stage + '... ' + info.progress + '%';
                                                                    const last = prev[prev.length - 1] || '';
                                                                    return (last.indexOf('%') !== -1) ? prev.slice(0, -1).concat(line) : prev.concat(line);
                                                                });
                                                            });
                                                            setHwLogLines(prev => prev.concat('[' + new Date().toLocaleTimeString() + '] Firmware upload successful! Reconnecting for live control...'));
                                                            const conn = await openWebSerialConnection(webSerialPortForFlash, {baudRate: 115200});
                                                            activateGlobalWebSerialConnection(conn);
                                                            setHwLogLines(prev => prev.concat('[' + new Date().toLocaleTimeString() + '] Reconnected.'));
                                                            hwFlashBusyRef.current = false;
                                                            return;
                                                        } catch (e) {
                                                            setHwLogLines(prev => prev.concat('[' + new Date().toLocaleTimeString() + '] Browser flash failed (' + e.message + ') - falling back to the agent...'));
                                                            // fall through to the existing agent-based path below
                                                        }
                                                    }
                                                }

                                                // Capture port BEFORE releasing Web Serial (disconnect clears it).
                                                var port2 = window.__hardwareConnection && window.__hardwareConnection.port;
                                                try {
                                                    // Release the browser's Web Serial handle first so
                                                    // avrdude/arduino-cli can open the port.
                                                    if (window.__hardwareConnection && window.__hardwareConnection.disconnect) {
                                                        try { await window.__hardwareConnection.disconnect(); } catch (_) {}
                                                    }
                                                    const apiBase = await getHwApiBase();
                                                    if (!port2) {
                                                        setHwLogLines(prev => prev.concat('[' + ts + '] ERROR: Not connected to any port. Connect your board first.'));
                                                        return;
                                                    }
                                                    const boardId = hwUploadBoard ? hwUploadBoard.id : 'arduino_uno';
                                                    const token = localStorage.getItem('auth_token');
                                                    if (!token) { window.location.href = '/login'; return; }
                                                    const r = await fetch(apiBase + '/firmware/upload-stage', {
                                                        method: 'POST',
                                                        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token},
                                                        body: JSON.stringify({boardType: boardId, port: port2})
                                                    });
                                                    const data = await r.json();
                                                    const ts2 = new Date().toLocaleTimeString();
                                                    if (data.success) {
                                                        setHwLogLines(prev => prev.concat(
                                                            '[' + ts2 + '] Firmware upload successful!',
                                                            '[' + ts2 + '] ' + (data.compileOutput || '').split('\n')[0],
                                                            '[' + ts2 + '] ' + (data.uploadOutput || '').split('\n')[0]
                                                        ));
                                                        if (data.device) {
                                                            window.__hardwareConnection = {
                                                                id: data.device.id,
                                                                port: data.device.path,
                                                                board: boardId,
                                                                baudRate: data.device.baudRate
                                                            };
                                                        }
                                                    } else {
                                                        setHwLogLines(prev => prev.concat('[' + ts2 + '] ERROR: ' + (data.error || 'Unknown error')));
                                                    }
                                                } catch (e) {
                                                    const ts2 = new Date().toLocaleTimeString();
                                                    setHwLogLines(prev => prev.concat('[' + ts2 + '] ERROR: ' + e.message));
                                                } finally {
                                                    hwFlashBusyRef.current = false;
                                                }
                                            }}
                                        >{'⚡ Firmware'}</button>
                                        <button
                                            className={styles.hwUploadCodeBtn}
                                            title="Upload Code: Compile and upload the current sketch to the board"
                                            // eslint-disable-next-line react/jsx-no-bind
                                            onClick={async () => {
                                                const ts = new Date().toLocaleTimeString();
                                                if (hwFlashBusyRef.current) {
                                                    setHwLogLines(prev => prev.concat('[' + ts + '] Upload already running - please wait...'));
                                                    return;
                                                }
                                                hwFlashBusyRef.current = true;
                                                setHwLogLines(prev => prev.concat('[' + ts + '] Starting upload...'));
                                                setHwBottomTab(0);

                                                // Phase 2: flash directly from the browser over Web Serial - no
                                                // agent needed for the flashing step itself (compiling still
                                                // needs a reachable arduino-cli, via the agent or local backend,
                                                // through getHwApiBase()). Only covers Uno/Nano (STK500v1/
                                                // Optiboot) for now - Mega (STK500v2) and ESP32 (its own ROM
                                                // loader protocol) fall through to the existing agent-based path.
                                                const boardId = hwUploadBoard ? hwUploadBoard.id : 'arduino_uno';
                                                const isAtmega328p = boardId === 'arduino_uno' || boardId === 'arduino_nano';
                                                const webSerialPort = window.__hardwareConnection && window.__hardwareConnection.webSerialPort;
                                                if (isAtmega328p && webSerialPort) {
                                                    try {
                                                        if (window.__hardwareConnection.disconnect) {
                                                            await window.__hardwareConnection.disconnect();
                                                        }
                                                        const apiBase = await getHwApiBase();
                                                        setHwLogLines(prev => prev.concat('[' + new Date().toLocaleTimeString() + '] Compiling...'));
                                                        const r = await fetch(apiBase + '/compiler/compile-only', {
                                                            method: 'POST',
                                                            headers: {'Content-Type': 'application/json'},
                                                            body: JSON.stringify({cppCode: hwUploadCode, board: BOARD_FQBN[boardId] || 'arduino:avr:uno'})
                                                        });
                                                        const data = await r.json();
                                                        if (!data.success) throw new Error(data.error || 'Compile failed');
                                                        setHwLogLines(prev => prev.concat('[' + new Date().toLocaleTimeString() + '] ' + (data.compileOutput || '').split('\n')[0]));
                                                        setHwLogLines(prev => prev.concat('[' + new Date().toLocaleTimeString() + '] Flashing directly over Web Serial (no agent)...'));
                                                        await flashAtmega328p(webSerialPort, data.hex, (info) => {
                                                            setHwLogLines(prev => {
                                                                const line = '[' + new Date().toLocaleTimeString() + '] ' + info.stage + '... ' + info.progress + '%';
                                                                const last = prev[prev.length - 1] || '';
                                                                // Overwrite the previous progress line instead of spamming the log.
                                                                return (last.indexOf('%') !== -1) ? prev.slice(0, -1).concat(line) : prev.concat(line);
                                                            });
                                                        });
                                                        setHwLogLines(prev => prev.concat('[' + new Date().toLocaleTimeString() + '] Upload successful! (flashed directly from the browser)'));
                                                        hwFlashBusyRef.current = false;
                                                        return;
                                                    } catch (e) {
                                                        setHwLogLines(prev => prev.concat('[' + new Date().toLocaleTimeString() + '] Browser flash failed (' + e.message + ') - falling back to the agent...'));
                                                        // fall through to the existing agent-based path below
                                                    }
                                                }

                                                // Capture port BEFORE releasing Web Serial (disconnect clears it).
                                                var port2 = window.__hardwareConnection && window.__hardwareConnection.port;
                                                try {
                                                    // Release the browser's Web Serial handle first so
                                                    // avrdude/arduino-cli can open the port.
                                                    if (window.__hardwareConnection && window.__hardwareConnection.disconnect) {
                                                        try { await window.__hardwareConnection.disconnect(); } catch (_) {}
                                                    }
                                                    const apiBase = await getHwApiBase();
                                                    
                                                    // Detect COM Port - if not connected, show port picker
                                                    if (!port2) {
                                                        const data = await fetch(apiBase + '/serial/ports').then(r => r.json());
                                                        const ports = (data && data.ports) || [];
                                                        if (ports.length === 0) {
                                                            setHwLogLines(prev => prev.concat('[' + new Date().toLocaleTimeString() + '] ERROR: No serial ports found. Connect your Arduino.'));
                                                            return;
                                                        }
                                                        port2 = await new Promise((resolve) => {
                                                            const overlay = document.createElement('div');
                                                            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:999999;display:flex;align-items:center;justify-content:center;';
                                                            const dialog = document.createElement('div');
                                                            dialog.style.cssText = 'background:#fff;border-radius:12px;padding:24px;min-width:340px;max-width:450px;box-shadow:0 8px 32px rgba(0,0,0,0.3);font-family:Arial,sans-serif;';
                                                            dialog.innerHTML = '<h3 style="margin:0 0 6px;color:#333;font-size:18px;">Select Serial Port</h3><p style="margin:0 0 12px;color:#666;font-size:13px;">Available ports:</p>';
                                                            var list = document.createElement('div');
                                                            list.style.cssText = 'max-height:280px;overflow-y:auto;';
                                                            ports.forEach(function(p) {
                                                                var btn = document.createElement('button');
                                                                btn.textContent = p.path + (p.manufacturer ? ' (' + p.manufacturer + ')' : '');
                                                                btn.style.cssText = 'display:block;width:100%;padding:12px 14px;margin:4px 0;border:1px solid #ddd;border-radius:6px;cursor:pointer;background:#f8f8f8;text-align:left;font-size:14px;';
                                                                btn.onmouseover = function(){this.style.background='#e8f4f8';this.style.borderColor='#00979D';};
                                                                btn.onmouseout = function(){this.style.background='#f8f8f8';this.style.borderColor='#ddd';};
                                                                btn.onclick = function() { overlay.remove(); resolve(p.path); };
                                                                list.appendChild(btn);
                                                            });
                                                            dialog.appendChild(list);
                                                            var cancel = document.createElement('button');
                                                            cancel.textContent = 'Cancel';
                                                            cancel.style.cssText = 'margin-top:14px;padding:10px 24px;border:1px solid #ccc;border-radius:6px;cursor:pointer;background:#f0f0f0;font-size:14px;display:block;width:100%;';
                                                            cancel.onmouseover = function(){this.style.background='#e0e0e0';};
                                                            cancel.onmouseout = function(){this.style.background='#f0f0f0';};
                                                            cancel.onclick = function(){overlay.remove(); resolve(null);};
                                                            dialog.appendChild(cancel);
                                                            overlay.appendChild(dialog);
                                                            document.body.appendChild(overlay);
                                                        });
                                                        if (!port2) {
                                                            setHwLogLines(prev => prev.concat('[' + new Date().toLocaleTimeString() + '] Upload cancelled.'));
                                                            return;
                                                        }
                                                        // Connect to selected port
                                                        const cr = await fetch(apiBase + '/serial/connect', {
                                                            method: 'POST',
                                                            headers: {'Content-Type': 'application/json'},
                                                            body: JSON.stringify({path: port2, baudRate: 115200, boardType: hwUploadBoard ? hwUploadBoard.id : 'arduino_uno'})
                                                        }).then(r => r.json());
                                                        if (cr.success && cr.device) {
                                                            window.__hardwareConnection = window.__hardwareConnection || {};
                                                            window.__hardwareConnection.port = port2;
                                                            window.__hardwareConnection.id = cr.device.id;
                                                            setHwLogLines(prev => prev.concat('[' + new Date().toLocaleTimeString() + '] Connected to ' + port2));
                                                        } else {
                                                            setHwLogLines(prev => prev.concat('[' + new Date().toLocaleTimeString() + '] ERROR: Connection failed - ' + (cr.error || 'Unknown error')));
                                                            return;
                                                        }
                                                    }
                                                    
                                                    // Compile Scratch Blocks → Generate Arduino C++ → arduino-cli compile → HEX/BIN → avrdude/esptool/bossac → Board
                                                    const r = await fetch(apiBase + '/compiler/compile-upload-cpp', {
                                                        method: 'POST',
                                                        headers: {'Content-Type': 'application/json'},
                                                        body: JSON.stringify({
                                                            cppCode: hwUploadCode,
                                                            port: port2,
                                                             board: BOARD_FQBN[hwUploadBoard?.id] || 'arduino:avr:uno'
                                                        })
                                                    });
                                                    const data = await r.json();
                                                    const ts2 = new Date().toLocaleTimeString();
                                                    if (data.success) {
                                                        setHwLogLines(prev => prev.concat(
                                                            '[' + ts2 + '] Upload successful!',
                                                            '[' + ts2 + '] ' + (data.compileOutput || '').split('\n')[0],
                                                            '[' + ts2 + '] ' + (data.uploadOutput || '').split('\n')[0]
                                                        ));
                                                    } else {
                                                        setHwLogLines(prev => prev.concat('[' + ts2 + '] ERROR: ' + (data.error || 'Unknown error')));
                                                    }
                                                } catch (e) {
                                                    const ts2 = new Date().toLocaleTimeString();
                                                    setHwLogLines(prev => prev.concat('[' + ts2 + '] ERROR: ' + e.message));
                                                } finally {
                                                    hwFlashBusyRef.current = false;
                                                }
                                            }}
                                        >{'⬆ Upload Code'}</button>
                                        <span className={styles.hwCodeLangLabel}>{'C++'}</span>
                                    </div>
                                    <div className={styles.hwCodeEditorArea}>
                                        <div
                                            ref={hwLineNumRef}
                                            className={styles.hwLineNumbers}
                                        >
                                            {hwUploadCode.split('\n').map((_, i) => (
                                                <div
                                                    key={i}
                                                    className={styles.hwLineNum}
                                                >{i + 1}</div>
                                            ))}
                                        </div>
                                        <textarea
                                            className={classNames(styles.hwCodeTextarea, hwCodeLocked ? styles.hwCodeTextareaLocked : null)}
                                            spellCheck={false}
                                            readOnly={hwCodeLocked}
                                            value={hwUploadCode}
                                            // eslint-disable-next-line react/jsx-no-bind
                                            onChange={e => { if (!hwCodeLocked) setHwUploadCode(e.target.value); }}
                                            // eslint-disable-next-line react/jsx-no-bind
                                            onScroll={e => {
                                                if (hwLineNumRef.current) {
                                                    hwLineNumRef.current.scrollTop = e.target.scrollTop;
                                                }
                                            }}
                                        />
                                    </div>
                                    <div className={styles.hwCodeBottomPanel}>
                                        <div className={styles.hwCodeBottomTabs}>
                                            <button
                                                className={hwBottomTab === 0 ? styles.hwCodeBottomTabActive : styles.hwCodeBottomTab}
                                                // eslint-disable-next-line react/jsx-no-bind
                                                onClick={() => setHwBottomTab(0)}
                                            >{'>> Log'}</button>
                                            <button
                                                className={hwBottomTab === 1 ? styles.hwCodeBottomTabActive : styles.hwCodeBottomTab}
                                                // eslint-disable-next-line react/jsx-no-bind
                                                onClick={() => setHwBottomTab(1)}
                                            >{'⇄ Serial Monitor'}</button>
                                        </div>
                                        <div className={styles.hwCodeBottomContent}>
                                            {hwBottomTab === 0 ? (
                                                hwLogLines.length === 0 ? null :
                                                    hwLogLines.map((line, i) => (
                                                        <div key={i} className={styles.hwLogLine}>{line}</div>
                                                    ))
                                            ) : (
                                                <div className={styles.hwSerialPlaceholder}>{'Serial Monitor — connect via Serial to use'}</div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <React.Fragment>
                                    <StageWrapper
                                        isFullScreen={isFullScreen}
                                        isRendererSupported={isRendererSupported()}
                                        isRtl={isRtl}
                                        stageSize={stageSize}
                                        vm={vm}
                                    />
                                    <Box className={styles.targetWrapper}>
                                        <TargetPane
                                            stageSize={stageSize}
                                            vm={vm}
                                        />
                                    </Box>
                                </React.Fragment>
                            )}
                        </Box>
                    </Box>
                </Box>
                <DragLayer />
            </Box>
        );
    }}</MediaQuery>);
};

GUIComponent.propTypes = {
    accountNavOpen: PropTypes.bool,
    activeTabIndex: PropTypes.number,
    authorId: PropTypes.oneOfType([PropTypes.string, PropTypes.bool]), // can be false
    authorThumbnailUrl: PropTypes.string,
    authorUsername: PropTypes.oneOfType([PropTypes.string, PropTypes.bool]), // can be false
    backdropLibraryVisible: PropTypes.bool,
    backpackHost: PropTypes.string,
    backpackVisible: PropTypes.bool,
    basePath: PropTypes.string,
    blocksTabVisible: PropTypes.bool,
    blocksId: PropTypes.string,
    canChangeLanguage: PropTypes.bool,
    canChangeTheme: PropTypes.bool,
    canCreateCopy: PropTypes.bool,
    canCreateNew: PropTypes.bool,
    canEditTitle: PropTypes.bool,
    canManageFiles: PropTypes.bool,
    canRemix: PropTypes.bool,
    canSave: PropTypes.bool,
    canShare: PropTypes.bool,
    canUseCloud: PropTypes.bool,
    cardsVisible: PropTypes.bool,
    children: PropTypes.node,
    costumeLibraryVisible: PropTypes.bool,
    costumesTabVisible: PropTypes.bool,
    customStageSize: PropTypes.shape({
        width: PropTypes.number,
        height: PropTypes.number
    }),
    enableCommunity: PropTypes.bool,
    intl: intlShape.isRequired,
    isCreating: PropTypes.bool,
    isEmbedded: PropTypes.bool,
    isFullScreen: PropTypes.bool,
    isPlayerOnly: PropTypes.bool,
    isRtl: PropTypes.bool,
    isShared: PropTypes.bool,
    isWindowFullScreen: PropTypes.bool,
    isTotallyNormal: PropTypes.bool,
    loading: PropTypes.bool,
    logo: PropTypes.string,
    onActivateCostumesTab: PropTypes.func,
    onActivateSoundsTab: PropTypes.func,
    onActivateTab: PropTypes.func,
    onClickAccountNav: PropTypes.func,
    onClickAddonSettings: PropTypes.func,
    onClickDesktopSettings: PropTypes.func,
    onClickNewWindow: PropTypes.func,
    onClickPackager: PropTypes.func,
    onClickLogo: PropTypes.func,
    onCloseAccountNav: PropTypes.func,
    onExtensionButtonClick: PropTypes.func,
    onOpenCustomExtensionModal: PropTypes.func,
    onLogOut: PropTypes.func,
    onOpenRegistration: PropTypes.func,
    onRequestCloseBackdropLibrary: PropTypes.func,
    onRequestCloseCostumeLibrary: PropTypes.func,
    onRequestCloseTelemetryModal: PropTypes.func,
    onSeeCommunity: PropTypes.func,
    onShare: PropTypes.func,
    onShowPrivacyPolicy: PropTypes.func,
    onStartSelectingFileUpload: PropTypes.func,
    onTabSelect: PropTypes.func,
    onTelemetryModalCancel: PropTypes.func,
    onTelemetryModalOptIn: PropTypes.func,
    onTelemetryModalOptOut: PropTypes.func,
    onToggleLoginOpen: PropTypes.func,
    renderLogin: PropTypes.func,
    securityManager: PropTypes.shape({}),
    showComingSoon: PropTypes.bool,
    showOpenFilePicker: PropTypes.func,
    showSaveFilePicker: PropTypes.func,
    soundsTabVisible: PropTypes.bool,
    stageSizeMode: PropTypes.oneOf(Object.keys(STAGE_SIZE_MODES)),
    targetIsStage: PropTypes.bool,
    telemetryModalVisible: PropTypes.bool,
    theme: PropTypes.instanceOf(Theme),
    tipsLibraryVisible: PropTypes.bool,
    usernameModalVisible: PropTypes.bool,
    settingsModalVisible: PropTypes.bool,
    customExtensionModalVisible: PropTypes.bool,
    fontsModalVisible: PropTypes.bool,
    unknownPlatformModalVisible: PropTypes.bool,
    invalidProjectModalVisible: PropTypes.bool,
    vm: PropTypes.instanceOf(VM).isRequired
};
GUIComponent.defaultProps = {
    backpackHost: null,
    backpackVisible: false,
    basePath: './',
    blocksId: 'original',
    canChangeLanguage: true,
    canChangeTheme: true,
    canCreateNew: false,
    canEditTitle: false,
    canManageFiles: true,
    canRemix: false,
    canSave: false,
    canCreateCopy: false,
    canShare: false,
    canUseCloud: false,
    enableCommunity: false,
    isCreating: false,
    isShared: false,
    isTotallyNormal: false,
    loading: false,
    showComingSoon: false,
    stageSizeMode: STAGE_SIZE_MODES.large
};

const mapStateToProps = state => ({
    customStageSize: state.scratchGui.customStageSize,
    isWindowFullScreen: state.scratchGui.tw.isWindowFullScreen,
    // This is the button's mode, as opposed to the actual current state
    blocksId: state.scratchGui.timeTravel.year.toString(),
    stageSizeMode: state.scratchGui.stageSize.stageSize,
    theme: state.scratchGui.theme.theme
});

export default injectIntl(connect(
    mapStateToProps
)(GUIComponent));
