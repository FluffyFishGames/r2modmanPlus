import Vue from 'vue';
import Vuex, { ActionContext, GetterTree } from 'vuex';

import ErrorModule from './modules/ErrorModule';
import ModalsModule from './modules/ModalsModule';
import ModFilterModule from './modules/ModFilterModule';
import ProfileModule from './modules/ProfileModule';
import { FolderMigration } from '../migrations/FolderMigration';
import Game from '../model/game/Game';
import GameManager from '../model/game/GameManager';
import R2Error from '../model/errors/R2Error';
import ManifestV2 from '../model/ManifestV2';
import ThunderstoreMod from '../model/ThunderstoreMod';
import ThunderstoreVersion from '../model/ThunderstoreVersion';
import ThunderstorePackages from '../r2mm/data/ThunderstorePackages';
import ManagerSettings from '../r2mm/manager/ManagerSettings';
import * as PackageDb from '../r2mm/manager/PackageDexieStore';

Vue.use(Vuex);

interface CachedMod {
    tsMod: ThunderstoreMod | undefined;
    isLatest: boolean;
}

export interface State {
    activeGame: Game;
    apiConnectionError: string;
    deprecatedMods: Map<string, boolean>;
    dismissedUpdateAll: boolean;
    isMigrationChecked: boolean;
    thunderstoreModList: ThunderstoreMod[];
    thunderstoreModCache: Map<string, CachedMod>;
    _settings: ManagerSettings | null;
}

type Context = ActionContext<State, State>;

/*
 * If not building with SSR mode, you can
 * directly export the Store instantiation
 */

export const store = {
    state: {
        activeGame: GameManager.defaultGame,
        thunderstoreModList: [],
        thunderstoreModCache: new Map<string, CachedMod>(),
        dismissedUpdateAll: false,
        isMigrationChecked: false,
        apiConnectionError: "",
        deprecatedMods: new Map<string, boolean>(),

        // Access through getters to ensure the settings are loaded.
        _settings: null,
    },
    actions: {
        // TODO: move package list related stuff to a separate module?
        // TODO: change this to handle the whole pipeline(?):
        //       API request -> IndexedDB update -> Vuex state update
        //       Need to take into account the different approaches in
        //       SplashMixin's foreground and UtilityMixin's background
        //       nature.
        async updateThunderstoreModList({commit, state}: Context) {
            const modList = await PackageDb.getPackagesAsThunderstoreMods(state.activeGame.internalFolderName);
            commit('setThunderstoreModList', modList);
            commit('setDeprecatedMods', modList);
            commit('clearModCache');
        },
        dismissUpdateAll({commit}: Context) {
            commit('dismissUpdateAll');
        },
        updateApiConnectionError({commit}: Context, err: string) {
            commit('setApiConnectionError', err);
        },
        async checkMigrations({commit, state}: Context) {
            if (state.isMigrationChecked) {
                return;
            }

            try {
                await FolderMigration.runMigration();
            } catch (e) {
                console.error(e);
            } finally {
                commit('setMigrationChecked');
            }
        },
        async setActiveGame({commit}: Context, game: Game) {
            commit('setActiveGame', game);
            commit('setSettings', await ManagerSettings.getSingleton(game));
        }
    },
    mutations: {
        setActiveGame(state: State, game: Game) {
            state.activeGame = game;
        },
        setThunderstoreModList(state: State, list: ThunderstoreMod[]) {
            state.thunderstoreModList = list;
        },
        dismissUpdateAll(state: State) {
            state.dismissedUpdateAll = true;
        },
        setMigrationChecked(state: State) {
            state.isMigrationChecked = true;
        },
        setApiConnectionError(state: State, err: string) {
            state.apiConnectionError = err;
        },
        setDeprecatedMods(state: State, allMods: ThunderstoreMod[]) {
            state.deprecatedMods = ThunderstorePackages.getDeprecatedPackageMap(allMods);
        },
        setSettings(state: State, settings: ManagerSettings) {
            state._settings = settings;
        },
        clearModCache(state: State) {
            state.thunderstoreModCache.clear();
        }
    },
    getters: <GetterTree<State, State>> {
        settings(state) {
            if (state._settings === null) {
                throw new R2Error(
                    'Accessing unset settings from Vuex store',
                    'getters.settings was called before actions.setActiveGame'
                );
            }

            if (state._settings.getContext().global.lastSelectedGame !== state.activeGame.internalFolderName) {
                throw new R2Error(
                    'Mismatch between active game and settings stored in Vuex store',
                    'Active game should be updated only via setActiveGame action'
                );
            }

            return state._settings;
        },

        // TODO: move package list related stuff to a separate module?
        cachedMod: (state) => (mod: ManifestV2): CachedMod => {
            const cacheKey = `${mod.getName()}-${mod.getVersionNumber()}`;

            if (state.thunderstoreModCache.get(cacheKey) === undefined) {
                const tsMod = state.thunderstoreModList.find((m) => m.getFullName() === mod.getName());

                // Updating Vuex state directly instead of mutations is a bad
                // practice but everything seems to work here since we only
                // mutate the map instead of replacing it altogether.
                if (tsMod === undefined) {
                    state.thunderstoreModCache.set(cacheKey, {tsMod: undefined, isLatest: true});
                } else {
                    const latestVersion = tsMod.getVersions().reduce(reduceToNewestVersion);
                    const isLatest = mod.getVersionNumber().isEqualOrNewerThan(latestVersion.getVersionNumber());
                    state.thunderstoreModCache.set(cacheKey, {tsMod, isLatest});
                }
            }

            return state.thunderstoreModCache.get(cacheKey) as CachedMod;
        },

        tsMod: (_state, getters) => (mod: ManifestV2): ThunderstoreMod | undefined => {
            return getters.cachedMod(mod).tsMod;
        },

        isLatestVersion: (_state, getters) => (mod: ManifestV2): boolean => {
            return getters.cachedMod(mod).isLatest;
        }
    },
    modules: {
        error: ErrorModule,
        modals: ModalsModule,
        modFilters: ModFilterModule,
        profile: ProfileModule,
    },

    // enable strict mode (adds overhead!)
    // for dev mode only
    strict: process.env.DEV === 'true'
};

/*
 * If not building with SSR mode, you can
 * directly export the Store instantiation
 */

export default (/* { ssrContext } */) => new Vuex.Store<State>(store);

const reduceToNewestVersion = (v1: ThunderstoreVersion, v2: ThunderstoreVersion) => {
    if (v1.getVersionNumber().isNewerThan(v2.getVersionNumber())) {
        return v1;
    }
    return v2;
};
