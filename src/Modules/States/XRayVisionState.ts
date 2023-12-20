import { SendAction, addCustomEffect, getRandomInt, hookFunction, isBind, isCloth, removeCustomEffect } from "utils";
import { BaseState, StateRestrictions } from "./BaseState";
import { StateModule } from "Modules/states";
import { ModuleCategory } from "Settings/setting_definitions";

export class XRayVisionState extends BaseState {
    Type: LSCGState = "x-ray-vision";

    Icon(C: OtherCharacter): string {
        return "Icons/Explore.png";
    }
    Label(C: OtherCharacter): string {
        return "X-Ray Vision";
    }

    constructor(state: StateModule) {
        super(state);
    }

    Init(): void {
        hookFunction("CommonCallFunctionByNameWarn", 1, (args, next) => {
            let funcName = args[0];
            let params = args[1]
            let C = params['C'] as OtherCharacter;
            let CA = params['CA'];
            let ret = next(args) ?? {};
            let regex = /Assets(.+)BeforeDraw/i;
            if (regex.test(funcName) && this.Active && this.CanViewXRay(C) && !!CA && isCloth(CA)) {
                let curOpacity = ret.Opacity ?? CA.Asset?.Opacity ?? 1;
                ret.Opacity = curOpacity * .5;
                ret.AlphaMasks = [];
            }
            return ret;
        }, ModuleCategory.States);
    }

    Activate(memberNumber?: number | undefined, duration?: number | undefined, emote?: boolean | undefined): BaseState | undefined {
        let ret = super.Activate(memberNumber, duration, emote);
        ChatRoomCharacter.forEach(C => {
            CharacterLoadCanvas(C);
        });
        return ret;
    }

    Recover(emote?: boolean | undefined): BaseState | undefined {
        let ret = super.Recover(emote);
        ChatRoomCharacter.forEach(C => {
            CharacterLoadCanvas(C);
        });
        return ret;
    }

    CanViewXRay(C: PlayerCharacter | OtherCharacter) {
        return (C?.LSCG?.MagicModule?.enabled && !C?.LSCG?.MagicModule?.blockXRay) ?? false;
    }

    RoomSync(): void {}

    SpeechBlock(): void {}
}