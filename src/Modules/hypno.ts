import { BaseModule } from 'base';
import { HypnoSettingsModel } from 'Settings/Models/hypno';
import { ModuleCategory, Subscreen } from 'Settings/setting_definitions';
import { settingsSave, parseMsgWords, OnAction, OnActivity, SendAction, getRandomInt, hookFunction, removeAllHooksByModule, callOriginal, setOrIgnoreBlush, isAllowedMember, isPhraseInString, GetTargetCharacter, GetDelimitedList, GetActivityEntryFromContent, escapeRegExp, IsActivityAllowed } from '../utils';
import { GuiHypno } from 'Settings/hypno';
import { ActivityModule } from './activities';
import { getModule } from 'modules';
import { ActivityEntryModel } from 'Settings/Models/activities';
import { InjectorModule } from './injector';
import { StateModule } from './states';

export class HypnoModule extends BaseModule {
    get settings(): HypnoSettingsModel {
        return super.settings as HypnoSettingsModel;
	}

    get settingsScreen(): Subscreen | null {
        return GuiHypno;
    }

    get defaultSettings(){
        return <HypnoSettingsModel>{
            enabled: false,
            //activatedAt: 0,
            //recoveredAt: 0,
            cycleTime: 30,
            enableCycle: true,
            triggerCycled: true,
            overrideMemberIds: "",
            overrideWords: "",
            allowLocked: false,
            remoteAccess: false,
            remoteAccessRequiredTrance: true,
            allowRemoteModificationOfMemberOverride: false,
            cooldownTime: 0,
            enableArousal: false,
            //immersive: false,
            trigger: "",
            triggerTime: 5,
            locked: false,
            awakeners: "",
            //hypnotized: false,
            //hypnotizedBy: -1,
            limitRemoteAccessToHypnotizer: false,
            hypnoEyeColor: "#A2A2A2",
            hypnoEyeType: 9,
            speakTriggers: "",
            silenceTriggers: "",
            stats: {}
        };
    }

    safeword(): void {
        this.StateModule.HypnoState.Recover();
    }

    get StateModule(): StateModule {
        return getModule<StateModule>("StateModule");
    }

    load(): void {
        OnAction(1, ModuleCategory.Hypno, (data, sender, msg, metadata) => {
            if (!this.Enabled)
                return;
            var lowerMsgWords = parseMsgWords(msg);
            if ((lowerMsgWords?.indexOf("snaps") ?? -1) >= 0 && 
                sender?.MemberNumber != Player.MemberNumber &&
                this.hypnoActivated) {
                this.TriggerRestoreSnap();
            }
        });
        
        OnActivity(1, ModuleCategory.Hypno, (data, sender, msg, metadata) => {
            if (!this.Enabled)
                return;
            let target = GetTargetCharacter(data);
            if (!!target && target == Player.MemberNumber) {
                let activityEntry = GetActivityEntryFromContent(data.Content);
                if (!activityEntry || !sender || !IsActivityAllowed(activityEntry, sender))
                    return;
                if (activityEntry?.awakener && this.hypnoActivated && !sender?.IsPlayer())
                    this.TriggerRestoreBoop();
                // Special tummy rub hypno action for Bean
                else if (activityEntry?.hypno && !this.hypnoActivated && !this.IsOnCooldown() && (Player.ArousalSettings?.Progress ?? 0) >= activityEntry.hypnoThreshold) {
                    this.DelayedTrigger(activityEntry, sender?.MemberNumber);
                } else if (activityEntry?.sleep && !getModule<InjectorModule>("InjectorModule")?.asleep) {
                    this.DelayedTrigger(activityEntry, sender?.MemberNumber, true);
                }
            }
        });

        let handlerPriority = (ChatRoomMessageHandlers.find(h => h.Description == "Save chats and whispers to the chat log")?.Priority ?? 110) - 1;
        ChatRoomRegisterMessageHandler(<ChatRoomMessageHandler>{
            Priority: handlerPriority, // Try to make sure we run last. Other mods could potentially add handlers after this depending on arbitrary load order.
            Description: "LSCG Hypnosis Trigger Checks",
            Callback: (data: ServerChatRoomMessage, sender: Character, msg: string, metadata?: IChatRoomMessageMetadata) => {
                if (data.Type == "Chat" || data.Type == "Whisper") {
                    if (!this.Enabled)
                        return {msg: msg};

                    const C = sender;
                    if (ChatRoomIsViewActive(ChatRoomMapViewName) && !ChatRoomMapViewCharacterIsHearable(C))
                        return {msg: msg};
                        
                    // Check for non-garbled trigger word, this means a trigger word could be set to what garbled speech produces >.>
                    if (this.CheckTrigger(msg, C) && !this.IsOnCooldown()) {
                        msg = this.BlankOutTriggers(msg, C);
                        this.StartTriggerWord(true, C.MemberNumber);
                        return {msg: msg};
                    }

                    if (this.hypnoActivated) {
                        var lowerMsg = msg.toLowerCase();
                        var names = [CharacterNickname(Player)];
                        if (!!Player.Name && names.indexOf(Player.Name) == -1)
                            names.push(Player.Name);
                        if (names.some(n => isPhraseInString(lowerMsg, n)) || 
                            this.StateModule.HypnoState.config.activatedBy == C.MemberNumber || 
                            this.StateModule.HypnoState.config.activatedBy == -1 ||
                            C.MemberNumber == Player.MemberNumber) {
                            if (this.CheckAwakener(msg, C)) {
                                this.TriggerRestoreWord(C);
                            } else  {
                                this.CheckSpeechTriggers(msg, C);
                            }
                            msg = this.BlankOutTriggers(msg, C);
                        }
                        else
                            msg =  msg.replace(/\S/gm, '-');
                    }
                    
                    return { msg: msg }
                }
                return false;
            }
        });

        let lastCycleCheck = 0;
        hookFunction('TimerProcess', 1, (args, next) => {
            if (ActivityAllowed()) {
                var now = CommonTime();
                let triggerTimer = (this.settings.triggerTime ?? 5) * 60000;
                let hypnoEnd = this.StateModule.HypnoState.config.activatedAt + triggerTimer;
                
                if (this.hypnoActivated && this.settings.triggerTime > 0 && hypnoEnd < now) {
                    // Hypno Trigger Timeout --
                    this.TriggerRestoreTimeout();
                }
                if (!this.hypnoActivated && (lastCycleCheck + 5000) < now) {
                    lastCycleCheck = now;
                    this.CheckNewTrigger();
                }
            }
            return next(args);
        }, ModuleCategory.Injector);

        // Set Trigger
        if (!this.settings.trigger) {
            this.settings.trigger = this.getNewTriggerWord();            
        }
    }

    initializeTriggerWord() {
        var recycleFromCommon = !this.settings.overrideWords && (!this.settings.trigger || commonWords.indexOf(this.settings.trigger) == -1);
        if (recycleFromCommon) {
            this.settings.trigger = this.getNewTriggerWord();
            settingsSave();
        }
        else if (!!this.settings.overrideWords) {
            var words = this.settings.overrideWords.split(',').filter(word => !!word).map(word => word.toLocaleLowerCase());
            if (words.indexOf(this.settings.trigger) == -1)
                this.settings.trigger = this.getNewTriggerWord();
            settingsSave();
        }
    }

    unload(): void {
        removeAllHooksByModule(ModuleCategory.Hypno);
    }

    get awakeners(): string[] {
        return GetDelimitedList(this.settings.awakeners);
    }

    get triggers(): string[] {
        var overrideWords = GetDelimitedList(this.settings.overrideWords);
        if (overrideWords.length > 0 && !this.settings.enableCycle)
            return overrideWords;
        else
            return [this.settings.trigger];
    }

    get blockSpeechTriggers(): string[] {
        return GetDelimitedList(this.settings.silenceTriggers);
    }

    get allowSpeechTriggers(): string[] {
        return GetDelimitedList(this.settings.speakTriggers);
    }

    getNewTriggerWord(): string {
        var currentTrigger = this.settings.trigger;
        var words = GetDelimitedList(this.settings.overrideWords)?.filter((word, ix, arr) => !!word && arr.indexOf(word) == ix) ?? [];
        if (words.length <= 0)
            words = commonWords;

        if (words.length > 1 && words.indexOf(currentTrigger) > -1)
            words = words.filter(val => val != currentTrigger);

        return words[getRandomInt(words.length)]?.toLocaleLowerCase();
    }

    allowedSpeaker(speaker: Character | undefined): boolean {
        if (speaker?.MemberNumber == Player.MemberNumber)
            return false;
        var memberId = speaker?.MemberNumber ?? 0;
        var allowedMembers = GetDelimitedList(this.settings.overrideMemberIds).map(id => +id).filter(id => id > 0) ?? [];
        if (allowedMembers.length <= 0)
            return isAllowedMember(speaker);
        else return allowedMembers.includes(memberId);
    }

    BlankOutTriggers(msg: string, speaker: Character) {
        if (!this.StateModule.settings.immersive || !this.allowedSpeaker(speaker))
            return msg;

        let triggers = this.triggers.concat(this.awakeners);
        triggers.forEach(t => {
            let tWords = t.split(" ");
            tWords = tWords.map(tw => {
                let hashLength = Math.max(3, tw.length) + (getRandomInt(4) - 2);
                return new Array(hashLength + 1).join('-');
            });
            let str = "⚠" + tWords.join(" ") + "⚠";

            msg = msg.replaceAll(new RegExp("\\b" + escapeRegExp(t) + "\\b", "ig"), str);
        });
        return msg;
    }

    delayedHypnoStrings = [
        "%NAME%'s eyes flutter as %PRONOUN% fights to keep control of %POSSESSIVE% senses...",
        "%NAME% whimpers and struggles to stay awake...",
        "%NAME% can feel %POSSESSIVE% eyelids grow heavy as %PRONOUN% drifts on the edge of trance...",
        "%NAME% lets out a low moan as %POSSESSIVE% muscles relax and %PRONOUN% starts to drop..."
    ];

    delayedSleepStrings = [
        "%NAME%'s eyes flutter as %PRONOUN% fights to keep them open...",
        "%NAME% yawns and struggles to stay awake...",
        "%NAME% can feel %POSSESSIVE% eyelids grow heavy as %PRONOUN% drifts on the edge of sleep...",
        "%NAME% takes a deep, relaxing breath as %POSSESSIVE% muscles relax and %PRONOUN% eyes start to droop..."
    ]

    delayedActivations: Map<string, number> = new Map<string,number>();

    DelayedTrigger(activityEntry: ActivityEntryModel, memberNumber: number = 0, isSleep: boolean = false) {
        let entryName = activityEntry.group + "-" + activityEntry.name;
        
        setTimeout(() => {
            let activation = this.delayedActivations.get(entryName);
            if (!!activation) {
                activation = Math.max(0, activation - 1);
                this.delayedActivations.set(entryName, activation);
            }
        }, 5 * 60 * 1000);
        
        let count = this.delayedActivations.get(entryName) ?? 0;
        count++;
        if (count >= activityEntry.hypnoRequiredRepeats) {
            if (isSleep) {
                SendAction("%NAME% quivers with one last attempt to stay awake...");
                setTimeout(() => getModule<InjectorModule>("InjectorModule")?.Sleep(true), 4000);
            }
            else {
                SendAction("%NAME% trembles weakly with one last attempt to maintain %POSSESSIVE% senses...");
                setTimeout(() => this.StartTriggerWord(false, memberNumber), 4000);
            }
            count = 0; // reset repeats
        }
        else {
            let str = isSleep ? this.delayedSleepStrings[getRandomInt(this.delayedSleepStrings.length)] : this.delayedHypnoStrings[getRandomInt(this.delayedHypnoStrings.length)];
            SendAction(str);
        }
        this.delayedActivations.set(entryName, count);
    }

    CheckAwakener(msg: string, sender: Character): boolean {
        return this._CheckForTriggers(msg, sender, this.awakeners, true);
    }

    CheckSpeechTriggers(msg: string, sender: Character) {
        if (this._CheckForTriggers(msg, sender, this.blockSpeechTriggers, true)) {
            this.StateModule.HypnoState.PreventSpeech();
        } else if (this._CheckForTriggers(msg, sender, this.allowSpeechTriggers, true)) {
            this.StateModule.HypnoState.AllowSpeech();
        }
    }

    CheckTrigger(msg: string, sender: Character): boolean {
        return this._CheckForTriggers(msg, sender, this.triggers);
    }

    _CheckForTriggers(msg: string, sender: Character, triggers: string[], awakener: boolean = false): boolean {
        // Skip on OOC
        if (msg.startsWith("(") || !triggers)
            return false;

        let matched = triggers.some(trigger => {
            return isPhraseInString(msg, trigger);
        })        

        return (matched && 
            (awakener ? this.hypnoActivated : !this.hypnoActivated) &&
            this.allowedSpeaker(sender))
    }

    IsOnCooldown(): boolean {
        var now = new Date().getTime();
        if ((now - (this.settings.cooldownTime * 1000)) < this.StateModule.HypnoState.config.recoveredAt) {
            // Triggered during cooldown...
            if (!this.cooldownMsgSent){
                SendAction("%NAME%'s frowns as %PRONOUN% fights to remain conscious.");
                this.cooldownMsgSent = true;
            }
            return true;
        }
        return false;
    }

    StartTriggerWord(wasWord: boolean = true, memberNumber: number = 0) {
        if (this.hypnoActivated)
            return;

        this.cooldownMsgSent = false;
        this.settings.triggerCycled = false;
        if (!AudioShouldSilenceSound(true))
            AudioPlaySoundEffect("SciFiEffect", 1);
        
        if (wasWord)
            SendAction("%NAME%'s eyes immediately defocus, %POSSESSIVE% posture slumping slightly as %PRONOUN% loses control of %POSSESSIVE% body at the utterance of a trigger word.");
        else
            SendAction("%NAME%'s eyes glaze over, %POSSESSIVE% posture slumping weakly as %PRONOUN% loses control of %POSSESSIVE% body.");
        
        this.settings.stats.hypnotizedCount++;
        this.StateModule.HypnoState.Activate(memberNumber);
    }

    TriggerRestoreWord(speaker: Character) {
        SendAction("%NAME% snaps back into %POSSESSIVE% senses at %OPP_NAME%'s voice.", speaker);
        this.TriggerRestore();
    }

    TriggerRestoreBoop() {
        SendAction("%NAME% reboots, blinking and gasping as %PRONOUN% regains %POSSESSIVE% senses.");
        this.TriggerRestore();
    }

    TriggerRestoreSnap() {
        SendAction("%NAME% blinks, shaking %POSSESSIVE% head with confusion as %PRONOUN% regains %POSSESSIVE% senses.");
        this.TriggerRestore();
    }

    TriggerRestoreTimeout() {
        SendAction("%NAME% gasps, blinking and blushing with confusion.");
        this.TriggerRestore();
    }

    TriggerRestore() {        
        if (!AudioShouldSilenceSound(true))
            AudioPlaySoundEffect("SpankSkin");
        this.StateModule.HypnoState.Recover();
    }

    // _resetHypno() {
    //     this.ResetEyes();
    //     CharacterSetFacialExpression(Player, "Eyes", null);
    //     this.hypnoActivated = false;
    //     this.settings.recoveredAt = new Date().getTime();
    //     settingsSave(true);
    // }

    // HypnoHorny() {
    //     if (this.hypnoActivated) {
    //         // enforce eye expression
    //         this.EnforceEyes();
    //         CharacterSetFacialExpression(Player, "Eyebrows", "Lowered");
    //         CharacterSetFacialExpression(Player, "Eyes", "Dazed");

    //         if (this.settings.enableArousal) {
    //             var progress = Math.min(99, (Player.ArousalSettings?.Progress ?? 0) + 5);
    //             ActivitySetArousal(Player, progress);
    //         }
    //     }
    // }

    CheckNewTrigger() {
        if (this.hypnoActivated || !this.settings.enableCycle || this.settings.triggerCycled)
            return;
        var cycleAtTime = Math.max(this.StateModule.HypnoState.config.activatedAt, this.StateModule.HypnoState.config.recoveredAt) + (Math.max(1, this.settings.cycleTime || 0) * 60000)
        if (cycleAtTime < CommonTime())
            this.RollTriggerWord();
    }

    RollTriggerWord() {
        var newTrigger = this.getNewTriggerWord();
        if (newTrigger != this.settings.trigger)
            SendAction("%NAME% concentrates, breaking the hold the previous trigger word held over %POSSESSIVE%.");
        this.settings.trigger = newTrigger;
        this.settings.triggerCycled = true;
        settingsSave();
    }

    cooldownMsgSent = false;
    get hypnoActivated(): boolean {
        return this.StateModule?.HypnoState?.config.active ?? false;
        //return this.settings.hypnotized;
    }
    // set hypnoActivated(val) {
    //     this.settings.hypnotized = val;
    //     settingsSave(true);
    // }
}

// Trigger Words
const commonWords = [ "able", "about", "absolute", "accept", "account", "achieve", "across", "act", "active", "actual", "add", "address", "admit", "advertise", "affect", "afford", "after", "afternoon", "again", "against", "age", "agent", "ago", "agree", "air", "all", "allow", "almost", "along", "already", "alright", "although", "always", "america", "amount", "another", "answer", "apart", "apparent", "appear", "apply", "appoint", "approach", "appropriate", "area", "argue", "arm", "around", "arrange", "art", "ask", "associate", "assume", "attend", "authority", "available", "aware", "away", "awful", "baby", "back", "bad", "bag", "balance", "ball", "bank", "bar", "base", "basis", "bear", "beat", "beauty", "because", "become", "bed", "before", "begin", "behind", "believe", "benefit", "best", "bet", "between", "big", "bill", "birth", "bit", "black", "bloke", "blood", "blow", "blue", "board", "boat", "body", "book", "both", "bother", "bottle", "bottom", "box", "boy", "break", "brief", "brilliant", "bring", "britain", "brother", "budget", "build", "bus", "business", "busy", "buy", "cake", "call", "car", "card", "care", "carry", "case", "cat", "catch", "cause", "cent", "centre", "certain", "chair", "chairman", "chance", "change", "chap", "character", "charge", "cheap", "check", "child", "choice", "choose", "church", "city", "claim", "class", "clean", "clear", "client", "clock", "close", "closes", "clothe", "club", "coffee", "cold", "colleague", "collect", "college", "colour", "come", "comment", "commit", "committee", "common", "community", "company", "compare", "complete", "compute", "concern", "condition", "confer", "consider", "consult", "contact", "continue", "contract", "control", "converse", "cook", "copy", "corner", "correct", "cost", "could", "council", "count", "country", "county", "couple", "course", "court", "cover", "create", "cross", "cup", "current", "cut", "dad", "danger", "date", "day", "dead", "deal", "dear", "debate", "decide", "decision", "deep", "definite", "degree", "department", "depend", "describe", "design", "detail", "develop", "die", "difference", "difficult", "dinner", "direct", "discuss", "district", "divide", "doctor", "document", "dog", "door", "double", "doubt", "down", "draw", "dress", "drink", "drive", "drop", "dry", "due", "during", "each", "early", "east", "easy", "eat", "economy", "educate", "effect", "egg", "eight", "either", "elect", "electric", "eleven", "else", "employ", "encourage", "end", "engine", "english", "enjoy", "enough", "enter", "environment", "equal", "especial", "europe", "even", "evening", "ever", "every", "evidence", "exact", "example", "except", "excuse", "exercise", "exist", "expect", "expense", "experience", "explain", "express", "extra", "eye", "face", "fact", "fair", "fall", "family", "far", "farm", "fast", "father", "favour", "feed", "feel", "few", "field", "fight", "figure", "file", "fill", "film", "final", "finance", "find", "fine", "finish", "fire", "first", "fish", "fit", "five", "flat", "floor", "fly", "follow", "food", "foot", "force", "forget", "form", "fortune", "forward", "four", "france", "free", "friday", "friend", "from", "front", "full", "fun", "function", "fund", "further", "future", "game", "garden", "gas", "general", "germany", "girl", "give", "glass", "good", "goodbye", "govern", "grand", "grant", "great", "green", "ground", "group", "grow", "guess", "guy", "hair", "half", "hall", "hand", "hang", "happen", "happy", "hard", "hate", "have", "head", "health", "hear", "heart", "heat", "heavy", "hell", "help", "here", "high", "history", "hit", "hold", "holiday", "home", "honest", "hope", "horse", "hospital", "hot", "hour", "house", "however", "hullo", "hundred", "husband", "idea", "identify", "imagine", "important", "improve", "include", "income", "increase", "indeed", "individual", "industry", "inform", "inside", "instead", "insure", "interest", "into", "introduce", "invest", "involve", "issue", "item", "job", "join", "judge", "jump", "just", "keep", "key", "kid", "kill", "kind", "king", "kitchen", "knock", "know", "labour", "lad", "lady", "land", "language", "large", "last", "late", "laugh", "law", "lay", "lead", "learn", "leave", "left", "leg", "less", "letter", "level", "lie", "life", "light", "like", "likely", "limit", "line", "link", "list", "listen", "little", "live", "load", "local", "lock", "london", "long", "look", "lord", "lose", "lot", "love", "low", "luck", "lunch", "machine", "main", "major", "make", "man", "manage", "many", "mark", "market", "marry", "match", "matter", "may", "mean", "meaning", "measure", "meet", "member", "mention", "middle", "might", "mile", "milk", "million", "mind", "minister", "minus", "minute", "miss", "mister", "moment", "monday", "money", "month", "more", "morning", "most", "mother", "motion", "move", "much", "music", "must", "name", "nation", "nature", "near", "necessary", "need", "never", "news", "next", "nice", "night", "nine", "none", "normal", "north", "not", "note", "notice", "number", "obvious", "occasion", "odd", "off", "offer", "office", "often", "okay", "old", "on", "once", "one", "only", "open", "operate", "opportunity", "oppose", "order", "organize", "original", "other", "otherwise", "ought", "out", "over", "own", "pack", "page", "paint", "pair", "paper", "paragraph", "pardon", "parent", "park", "part", "particular", "party", "pass", "past", "pay", "pence", "pension", "people", "percent", "perfect", "perhaps", "period", "person", "photograph", "pick", "picture", "piece", "place", "plan", "play", "please", "plus", "point", "police", "policy", "politic", "poor", "position", "positive", "possible", "post", "pound", "power", "practise", "prepare", "present", "press", "pressure", "presume", "pretty", "previous", "price", "print", "private", "probable", "problem", "proceed", "process", "produce", "product", "programme", "project", "proper", "propose", "protect", "provide", "public", "pull", "purpose", "push", "quality", "quarter", "question", "quick", "quid", "quiet", "quite", "radio", "rail", "raise", "range", "rate", "rather", "read", "ready", "real", "realise", "really", "reason", "receive", "recent", "reckon", "recognize", "recommend", "record", "red", "reduce", "refer", "regard", "region", "relation", "remember", "report", "represent", "require", "research", "resource", "respect", "responsible", "rest", "result", "return", "right", "ring", "rise", "road", "role", "roll", "room", "round", "rule", "run", "safe", "sale", "same", "saturday", "save", "say", "scheme", "school", "science", "score", "scotland", "seat", "second", "secretary", "section", "secure", "see", "seem", "self", "sell", "send", "sense", "separate", "serious", "serve", "service", "set", "settle", "seven", "sex", "shall", "share", "she", "sheet", "shoe", "shoot", "shop", "short", "should", "show", "shut", "sick", "side", "sign", "similar", "simple", "since", "sing", "single", "sir", "sister", "sit", "site", "situate", "six", "size", "sleep", "slight", "slow", "small", "smoke", "social", "society", "some", "son", "soon", "sorry", "sort", "sound", "south", "space", "speak", "special", "specific", "speed", "spell", "spend", "square", "staff", "stage", "stairs", "stand", "standard", "start", "state", "station", "stay", "step", "stick", "still", "stop", "story", "straight", "strategy", "street", "strike", "strong", "structure", "student", "study", "stuff", "stupid", "subject", "succeed", "such", "sudden", "suggest", "suit", "summer", "sun", "sunday", "supply", "support", "suppose", "sure", "surprise", "switch", "system", "table", "take", "talk", "tape", "tax", "tea", "teach", "team", "telephone", "television", "tell", "ten", "tend", "term", "terrible", "test", "than", "thank", "the", "then", "there", "therefore", "they", "thing", "think", "thirteen", "thirty", "this", "thou", "though", "thousand", "three", "through", "throw", "thursday", "tie", "time", "today", "together", "tomorrow", "tonight", "too", "top", "total", "touch", "toward", "town", "trade", "traffic", "train", "transport", "travel", "treat", "tree", "trouble", "true", "trust", "try", "tuesday", "turn", "twelve", "twenty", "two", "type", "under", "understand", "union", "unit", "unite", "university", "unless", "until", "up", "upon", "use", "usual", "value", "various", "very", "video", "view", "village", "visit", "vote", "wage", "wait", "walk", "wall", "want", "war", "warm", "wash", "waste", "watch", "water", "way", "we", "wear", "wednesday", "week", "weigh", "welcome", "well", "west", "what", "when", "where", "whether", "which", "while", "white", "who", "whole", "why", "wide", "wife", "will", "win", "wind", "window", "wish", "with", "within", "without", "woman", "wonder", "wood", "word", "work", "world", "worry", "worse", "worth", "would", "write", "wrong", "year", "yes", "yesterday", "yet", "you", "young" ];



// ****************** Functions *****************

//let triggerActivated = false;
//let triggeredBy = 0;
